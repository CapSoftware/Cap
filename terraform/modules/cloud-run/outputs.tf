output "service_url" {
  description = "The URL of the Cloud Run service."
  value       = google_cloud_run_v2_service.main.uri
}
