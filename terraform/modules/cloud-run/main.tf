resource "google_cloud_run_v2_service" "main" {
  project  = var.project_id
  name     = var.service_name
  location = var.region

  template {
    containers {
      image = "gcr.io/cloudrun/hello"
      env {
        name  = "DB_USER"
        value_source {
          secret_key_ref {
            secret = var.db_user_secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "DB_PASS"
        value_source {
          secret_key_ref {
            secret  = var.db_password_secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "DB_NAME"
        value = var.db_name
      }
      env {
        name  = "INSTANCE_CONNECTION_NAME"
        value = var.db_connection_name
      }
    }
    vpc_access {
        connector = var.vpc_connector_id
        egress = "ALL_TRAFFIC"
    }
  }

  traffic {
    percent         = 100
    type            = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
  }

  depends_on = [
    var.db_user_secret_id,
    var.db_password_secret_id
  ]
}

resource "google_cloud_run_service_iam_member" "noauth" {
  location = google_cloud_run_v2_service.main.location
  project  = google_cloud_run_v2_service.main.project
  service  = google_cloud_run_v2_service.main.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
