terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }

    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Application = "AIRS Agent"
      Environment = "production"
      ManagedBy   = "Terraform"
      Owner       = "10573LLC"
    }
  }
}

data "aws_caller_identity" "current" {}

check "target_account" {
  assert {
    condition     = data.aws_caller_identity.current.account_id == var.expected_account_id
    error_message = "Refusing to deploy AIRS to an unexpected AWS account."
  }
}
