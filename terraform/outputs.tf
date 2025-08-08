output "cloud_run_service_url" {
  description = "The URL of the deployed Cloud Run service."
  value       = module.cloud_run.service_url
}
