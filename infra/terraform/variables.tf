variable "expected_account_id" {
  type        = string
  description = "Dedicated AIRS production member account ID."
}

variable "aws_region" {
  type    = string
  default = "us-east-2"
}

variable "app_name" {
  type    = string
  default = "airs-agent-prod"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "db_multi_az" {
  type    = bool
  default = false
}

variable "container_image" {
  type        = string
  description = "Immutable runtime ECR image URI for AIRS."
}

variable "ops_image" {
  type        = string
  description = "Immutable ops ECR image URI for migrations/bootstrap."
}

variable "deploy_services" {
  type        = bool
  default     = false
  description = "Enable app and maintenance services only after database bootstrap succeeds."
}

variable "enable_https" {
  type        = bool
  default     = false
  description = "Enable HTTPS listener and AIRS service only after ACM DNS validation is complete."
}

variable "desired_count" {
  type    = number
  default = 2
}

variable "task_cpu" {
  type    = number
  default = 512
}

variable "task_memory" {
  type    = number
  default = 1024
}

variable "domain_name" {
  type    = string
  default = "app.airsagent.com"
}

variable "public_base_url" {
  type    = string
  default = "https://app.airsagent.com"
}

variable "budget_email" {
  type    = string
  default = "developer@10573llc.com"
}

variable "monthly_budget_usd" {
  type    = number
  default = 75
}
