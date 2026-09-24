resource "random_password" "app_db" { length = 32; special = false }
resource "random_password" "maintenance_db" { length = 32; special = false }
resource "random_password" "session" { length = 64; special = false }

locals {
  db_host = aws_db_instance.main.address
  owner_url = "postgres://airs_owner:${urlencode(random_password.db_owner.result)}@${local.db_host}:5432/airs"
  app_url = "postgres://airs_app:${urlencode(random_password.app_db.result)}@${local.db_host}:5432/airs"
  maintenance_url = "postgres://airs_maintenance:${urlencode(random_password.maintenance_db.result)}@${local.db_host}:5432/airs"
}

resource "aws_secretsmanager_secret" "runtime" {
  name = "${var.app_name}/runtime"
  recovery_window_in_days = 30
}
resource "aws_secretsmanager_secret_version" "runtime" {
  secret_id = aws_secretsmanager_secret.runtime.id
  secret_string = jsonencode({
    DATABASE_URL = local.app_url
    AIRS_MAINTENANCE_DATABASE_URL = local.maintenance_url
    AIRS_BOOTSTRAP_DATABASE_URL = local.owner_url
    APP_DB_PASSWORD = random_password.app_db.result
    MAINTENANCE_DB_PASSWORD = random_password.maintenance_db.result
    SESSION_SECRET = random_password.session.result
  })
}

resource "aws_iam_role" "execution" {
  name = "${var.app_name}-execution-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}
resource "aws_iam_role_policy" "execution" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability","ecr:GetDownloadUrlForLayer","ecr:BatchGetImage"], Resource = aws_ecr_repository.app.arn },
      { Effect = "Allow", Action = ["logs:CreateLogStream","logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.app.arn}:*" },
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.runtime.arn }
    ]
  })
}

resource "aws_iam_role" "task" {
  name = "${var.app_name}-task-role"
  assume_role_policy = aws_iam_role.execution.assume_role_policy
}

resource "aws_lb" "app" {
  name = "airs-agent-prod"
  internal = false
  load_balancer_type = "application"
  security_groups = [aws_security_group.alb.id]
  subnets = aws_subnet.public[*].id
  enable_deletion_protection = true
}

resource "aws_lb_target_group" "app" {
  name = "airs-agent-prod"
  port = 3000
  protocol = "HTTP"
  target_type = "ip"
  vpc_id = aws_vpc.main.id
  health_check {
    enabled = true
    path = "/api/public/health"
    matcher = "200"
    interval = 30
    timeout = 5
    healthy_threshold = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port = 80
  protocol = "HTTP"
  default_action {
    type = var.certificate_arn == "" ? "forward" : "redirect"
    dynamic "forward" {
      for_each = var.certificate_arn == "" ? [1] : []
      content { target_group_arn = aws_lb_target_group.app.arn }
    }
    dynamic "redirect" {
      for_each = var.certificate_arn == "" ? [] : [1]
      content { port = "443"; protocol = "HTTPS"; status_code = "HTTP_301" }
    }
  }
}

resource "aws_lb_listener" "https" {
  count = var.certificate_arn == "" ? 0 : 1
  load_balancer_arn = aws_lb.app.arn
  port = 443
  protocol = "HTTPS"
  ssl_policy = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn = var.certificate_arn
  default_action { type = "forward"; target_group_arn = aws_lb_target_group.app.arn }
}

resource "aws_ecs_task_definition" "app" {
  family = var.app_name
  network_mode = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu = "512"
  memory = "1024"
  execution_role_arn = aws_iam_role.execution.arn
  task_role_arn = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name = "app"
    image = var.container_image
    essential = true
    portMappings = [{ containerPort = 3000, hostPort = 3000, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "3000" },
      { name = "HOST", value = "0.0.0.0" },
      { name = "DB_DRIVER", value = "postgres" },
      { name = "AUTH_DRIVER", value = "local" },
      { name = "AIRS_PUBLIC_BASE_URL", value = var.public_base_url },
      { name = "AIRS_MAINTENANCE_ENDPOINT_ENABLED", value = "false" }
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:DATABASE_URL::" },
      { name = "SESSION_SECRET", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:SESSION_SECRET::" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group" = aws_cloudwatch_log_group.app.name
        "awslogs-region" = var.aws_region
        "awslogs-stream-prefix" = "app"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "migration" {
  family = "${var.app_name}-migration"
  network_mode = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu = "512"
  memory = "1024"
  execution_role_arn = aws_iam_role.execution.arn
  task_role_arn = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name = "migration"
    image = var.container_image
    essential = true
    command = ["/bin/sh", "scripts/aws-production-db-bootstrap.sh"]
    secrets = [
      { name = "AIRS_BOOTSTRAP_DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:AIRS_BOOTSTRAP_DATABASE_URL::" },
      { name = "APP_DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:APP_DB_PASSWORD::" },
      { name = "MAINTENANCE_DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:MAINTENANCE_DB_PASSWORD::" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group" = aws_cloudwatch_log_group.app.name
        "awslogs-region" = var.aws_region
        "awslogs-stream-prefix" = "migration"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "maintenance" {
  family = "${var.app_name}-maintenance"
  network_mode = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu = "256"
  memory = "512"
  execution_role_arn = aws_iam_role.execution.arn
  task_role_arn = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name = "maintenance"
    image = var.container_image
    essential = true
    command = ["/bin/sh","-c","while true; do node scripts/expire-incident-state.mjs || echo sweep-failed; sleep 60; done"]
    secrets = [{ name = "AIRS_MAINTENANCE_DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:AIRS_MAINTENANCE_DATABASE_URL::" }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group" = aws_cloudwatch_log_group.app.name
        "awslogs-region" = var.aws_region
        "awslogs-stream-prefix" = "maintenance"
      }
    }
  }])
}

resource "aws_ecs_service" "app" {
  name = "${var.app_name}-app"
  cluster = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count = var.desired_count
  launch_type = "FARGATE"
  health_check_grace_period_seconds = 60
  network_configuration {
    subnets = aws_subnet.private[*].id
    security_groups = [aws_security_group.app.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name = "app"
    container_port = 3000
  }
  depends_on = [aws_lb_listener.http]
}

resource "aws_ecs_service" "maintenance" {
  name = "${var.app_name}-maintenance"
  cluster = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.maintenance.arn
  desired_count = 1
  launch_type = "FARGATE"
  network_configuration {
    subnets = aws_subnet.private[*].id
    security_groups = [aws_security_group.app.id]
    assign_public_ip = false
  }
}
