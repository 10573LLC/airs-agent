output "vpc_id" { value = aws_vpc.main.id }
output "private_subnet_ids" { value = aws_subnet.private[*].id }
output "public_subnet_ids" { value = aws_subnet.public[*].id }
output "ecr_repository_url" { value = aws_ecr_repository.app.repository_url }
output "ecs_cluster_name" { value = aws_ecs_cluster.main.name }
output "database_endpoint" { value = aws_db_instance.main.address }
output "app_security_group_id" { value = aws_security_group.app.id }
output "migration_task_definition_arn" { value = aws_ecs_task_definition.migration.arn }
output "app_service_name" { value = aws_ecs_service.app.name }
output "maintenance_service_name" { value = aws_ecs_service.maintenance.name }
output "alb_dns_name" { value = aws_lb.app.dns_name }
output "acm_certificate_arn" { value = aws_acm_certificate.app.arn }
output "acm_dns_validation" {
  value = [
    for option in aws_acm_certificate.app.domain_validation_options : {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  ]
}
output "cognito_user_pool_id" { value = aws_cognito_user_pool.app.id }
output "cognito_client_id" { value = aws_cognito_user_pool_client.app.id }
output "cognito_domain" { value = local.cognito_domain }
