variable "aws_region" { type = string; default = "us-east-2" }
variable "app_name" { type = string; default = "airs-agent-prod" }
variable "vpc_cidr" { type = string; default = "10.73.0.0/16" }
variable "db_instance_class" { type = string; default = "db.t4g.small" }
variable "container_image" { type = string; description = "Immutable ECR image URI for AIRS." }
variable "public_base_url" { type = string; description = "Canonical HTTPS AIRS origin." }

variable "certificate_arn" {
  type        = string
  description = "ACM certificate ARN for app.airsagent.com in us-east-2."
  default     = ""
}
variable "desired_count" { type = number; default = 1 }
