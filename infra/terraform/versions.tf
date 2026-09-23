terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "s3" {
    bucket       = "airs-agent-tfstate-509581811007"
    key          = "production/terraform.tfstate"
    region       = "us-east-2"
    encrypt      = true
    use_lockfile = true
  }
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
