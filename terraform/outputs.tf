output "cloud_run_service_urls" {
  description = "The URLs of the deployed Cloud Run services."
  value       = { for service_name, service in module.cloud_run : service_name => service.service_url }
}
