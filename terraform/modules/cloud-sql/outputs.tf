output "db_instance_connection_name" {
  description = "The connection name of the database instance."
  value       = google_sql_database_instance.main.connection_name
}

output "db_name" {
  description = "The name of the database."
  value       = google_sql_database.main.name
}

output "db_user_secret_id" {
  description = "The ID of the secret for the database user."
  value       = google_secret_manager_secret.db_user_secret.id
}

output "db_password_secret_id" {
  description = "The ID of the secret for the database password."
  value       = google_secret_manager_secret.db_password_secret.id
}
