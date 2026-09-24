data "aws_availability_zones" "available" { state = "available" }

locals { azs = slice(data.aws_availability_zones.available.names, 0, 2) }

resource "aws_vpc" "main" {
  cidr_block = var.vpc_cidr
  enable_dns_support = true
  enable_dns_hostnames = true
  tags = { Name = "${var.app_name}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags = { Name = "${var.app_name}-igw" }
}

resource "aws_subnet" "public" {
  count = 2
  vpc_id = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block = cidrsubnet(var.vpc_cidr, 8, count.index)
  map_public_ip_on_launch = true
  tags = { Name = "${var.app_name}-public-${count.index + 1}" }
}

resource "aws_subnet" "private" {
  count = 2
  vpc_id = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block = cidrsubnet(var.vpc_cidr, 8, 10 + count.index)
  tags = { Name = "${var.app_name}-private-${count.index + 1}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route { cidr_block = "0.0.0.0/0"; gateway_id = aws_internet_gateway.main.id }
  tags = { Name = "${var.app_name}-public-rt" }
}
resource "aws_route_table_association" "public" {
  count = 2
  subnet_id = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  count  = 2
  domain = "vpc"
  tags   = { Name = "${var.app_name}-nat-eip-${count.index + 1}" }
}

resource "aws_nat_gateway" "main" {
  count         = 2
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  depends_on    = [aws_internet_gateway.main]
  tags          = { Name = "${var.app_name}-nat-${count.index + 1}" }
}

resource "aws_route_table" "private" {
  count  = 2
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }
  tags = { Name = "${var.app_name}-private-rt-${count.index + 1}" }
}
resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

resource "aws_security_group" "alb" {
  name_prefix = "${var.app_name}-alb-"
  vpc_id = aws_vpc.main.id
  ingress { from_port = 80; to_port = 80; protocol = "tcp"; cidr_blocks = ["0.0.0.0/0"] }
  ingress { from_port = 443; to_port = 443; protocol = "tcp"; cidr_blocks = ["0.0.0.0/0"] }
  egress { from_port = 0; to_port = 0; protocol = "-1"; cidr_blocks = ["0.0.0.0/0"] }
  lifecycle { create_before_destroy = true }
}

resource "aws_security_group" "app" {
  name_prefix = "${var.app_name}-app-"
  vpc_id = aws_vpc.main.id
  ingress { from_port = 3000; to_port = 3000; protocol = "tcp"; security_groups = [aws_security_group.alb.id] }
  egress { from_port = 0; to_port = 0; protocol = "-1"; cidr_blocks = ["0.0.0.0/0"] }
  lifecycle { create_before_destroy = true }
}

resource "aws_security_group" "db" {
  name_prefix = "${var.app_name}-db-"
  vpc_id = aws_vpc.main.id
  ingress { from_port = 5432; to_port = 5432; protocol = "tcp"; security_groups = [aws_security_group.app.id] }
  lifecycle { create_before_destroy = true }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id = aws_vpc.main.id
  service_name = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids = aws_route_table.private[*].id
}


resource "aws_ecr_repository" "app" {
  name                 = "airs-agent"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}
resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the newest 30 immutable AIRS images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "app" {
  name = "/ecs/${var.app_name}"
  retention_in_days = 90
}

resource "aws_db_subnet_group" "main" {
  name = "${var.app_name}-db-subnets"
  subnet_ids = aws_subnet.private[*].id
}

resource "random_password" "db_owner" { length = 32; special = false }

resource "aws_secretsmanager_secret" "db_owner" {
  name = "${var.app_name}/db-owner"
  recovery_window_in_days = 30
}
resource "aws_secretsmanager_secret_version" "db_owner" {
  secret_id = aws_secretsmanager_secret.db_owner.id
  secret_string = random_password.db_owner.result
}

resource "aws_db_parameter_group" "main" {
  name   = "${var.app_name}-postgres16"
  family = "postgres16"
  parameter { name = "rds.force_ssl"; value = "1"; apply_method = "pending-reboot" }
}

resource "aws_db_instance" "main" {
  identifier = "${var.app_name}-db"
  engine = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class
  allocated_storage = 30
  max_allocated_storage = 100
  storage_type = "gp3"
  db_name = "airs"
  username = "airs_owner"
  password = random_password.db_owner.result
  db_subnet_group_name   = aws_db_subnet_group.main.name
  parameter_group_name   = aws_db_parameter_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible = false
  multi_az            = var.db_multi_az
  storage_encrypted = true
  backup_retention_period = 14
  deletion_protection = true
  skip_final_snapshot = false
  final_snapshot_identifier = "${var.app_name}-final"
}

resource "aws_ecs_cluster" "main" {
  name = var.app_name
  setting { name = "containerInsights"; value = "enhanced" }
}
