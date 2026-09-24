resource "random_password" "app_db" {
  length  = 32
  special = false
}

resource "random_password" "maintenance_db" {
  length  = 32
  special = false
}

resource "random_password" "session" {
  length  = 64
  special = false
}

locals {
  rds_ssl_query   = "?sslmode=verify-full&sslrootcert=/app/certs/rds-global.pem"
  bootstrap_url   = "postgresql://airs_owner@${aws_db_instance.main.address}:5432/airs${local.rds_ssl_query}"
  app_url         = "postgresql://airs_app:${urlencode(random_password.app_db.result)}@${aws_db_instance.main.address}:5432/airs${local.rds_ssl_query}"
  maintenance_url = "postgresql://airs_maintenance:${urlencode(random_password.maintenance_db.result)}@${aws_db_instance.main.address}:5432/airs${local.rds_ssl_query}"
  cognito_issuer  = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.app.id}"
  cognito_domain  = "https://${var.cognito_domain_prefix}.auth.${var.aws_region}.amazoncognito.com"
}

resource "aws_secretsmanager_secret" "runtime" {
  name                    = "${var.app_name}/runtime"
  recovery_window_in_days = 30
}
resource "aws_secretsmanager_secret_version" "runtime" {
  secret_id = aws_secretsmanager_secret.runtime.id
  secret_string = jsonencode({
    DATABASE_URL                  = local.app_url
    AIRS_MAINTENANCE_DATABASE_URL = local.maintenance_url
    APP_DB_PASSWORD               = random_password.app_db.result
    MAINTENANCE_DB_PASSWORD       = random_password.maintenance_db.result
    SESSION_SECRET                = random_password.session.result
    OIDC_CLIENT_SECRET            = aws_cognito_user_pool_client.app.client_secret
  })
}

resource "aws_iam_role" "execution" {
  name = "${var.app_name}-execution-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })
}
resource "aws_iam_role_policy" "execution" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      {
        Effect = "Allow"
        Action = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
        Resource = aws_ecr_repository.app.arn
      },
      {
        Effect = "Allow"
        Action = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.app.arn}:*"
      },
      {
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          aws_secretsmanager_secret.runtime.arn,
          aws_db_instance.main.master_user_secret[0].secret_arn
        ]
      }
    ]
  })
}

resource "aws_iam_role" "task" {
  name               = "${var.app_name}-task-role"
  assume_role_policy = aws_iam_role.execution.assume_role_policy
}

resource "aws_lb" "app" {
  name                       = "airs-agent-prod"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  enable_deletion_protection = true
}

resource "aws_lb_target_group" "app" {
  name        = "airs-agent-prod"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    enabled             = true
    path                = "/api/public/health"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http_forward" {
  count             = var.enable_https ? 0 : 1
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  count             = var.enable_https ? 1 : 0
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = var.enable_https ? 1 : 0
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.app.arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = var.app_name
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "app"
    image     = var.container_image
    essential = true
    user      = "node"
    portMappings = [{ containerPort = 3000, hostPort = 3000, protocol = "tcp", appProtocol = "http" }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "3000" },
      { name = "HOST", value = "0.0.0.0" },
      { name = "DB_DRIVER", value = "postgres" },
      { name = "AUTH_DRIVER", value = "oidc" },
      { name = "AIRS_PUBLIC_BASE_URL", value = var.public_base_url },
      { name = "OIDC_ISSUER", value = local.cognito_issuer },
      { name = "OIDC_DOMAIN", value = local.cognito_domain },
      { name = "OIDC_CLIENT_ID", value = aws_cognito_user_pool_client.app.id },
      { name = "AIRS_MAINTENANCE_ENDPOINT_ENABLED", value = "false" }
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:DATABASE_URL::" },
      { name = "SESSION_SECRET", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:SESSION_SECRET::" },
      { name = "OIDC_CLIENT_SECRET", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:OIDC_CLIENT_SECRET::" }
    ]
    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/api/public/health | grep -q '\"status\":\"ok\"' || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "app"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "migration" {
  family                   = "${var.app_name}-migration"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "migration"
    image     = var.ops_image
    essential = true
    user      = "node"
    command   = ["/bin/sh", "scripts/aws-production-db-bootstrap.sh"]
    environment = [
      { name = "AIRS_BOOTSTRAP_DATABASE_URL", value = local.bootstrap_url }
    ]
    secrets = [
      { name = "PGPASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
      { name = "APP_DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:APP_DB_PASSWORD::" },
      { name = "MAINTENANCE_DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:MAINTENANCE_DB_PASSWORD::" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "migration"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "maintenance" {
  family                   = "${var.app_name}-maintenance"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([{
    name      = "maintenance"
    image     = var.container_image
    essential = true
    user      = "node"
    command   = ["/bin/sh", "-c", "while true; do node scripts/expire-incident-state.mjs || echo sweep-failed; sleep 60; done"]
    secrets   = [{ name = "AIRS_MAINTENANCE_DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:AIRS_MAINTENANCE_DATABASE_URL::" }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "maintenance"
      }
    }
  }])
}

resource "aws_ecs_service" "app" {
  name                               = "${var.app_name}-app"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.app.arn
  desired_count                      = var.deploy_services && var.enable_https ? var.desired_count : 0
  launch_type                        = "FARGATE"
  health_check_grace_period_seconds  = 90
  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.http_forward, aws_lb_listener.http_redirect, aws_lb_listener.https]
}

resource "aws_ecs_service" "maintenance" {
  name            = "${var.app_name}-maintenance"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.maintenance.arn
  desired_count   = var.deploy_services && var.enable_https ? 1 : 0
  launch_type     = "FARGATE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }
}
