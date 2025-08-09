resource "google_cloud_run_v2_service" "main" {
  project  = var.project_id
  name     = var.service_name
  location = var.region

  template {
    containers {
      image = var.image_url
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
      dynamic "env" {
        for_each = var.google_client_id_secret_id != null ? { "GOOGLE_CLIENT_ID" = var.google_client_id_secret_id } : {}
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.google_client_secret_secret_id != null ? { "GOOGLE_CLIENT_SECRET" = var.google_client_secret_secret_id } : {}
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.workos_client_id_secret_id != null ? { "WORKOS_CLIENT_ID" = var.workos_client_id_secret_id } : {}
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.workos_api_key_secret_id != null ? { "WORKOS_API_KEY" = var.workos_api_key_secret_id } : {}
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.resend_api_key_secret_id != null ? { "RESEND_API_KEY" = var.resend_api_key_secret_id } : {}
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.nextauth_secret_secret_id != null ? { "NEXTAUTH_SECRET" = var.nextauth_secret_secret_id } : {}
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.web_url != null ? { "WEB_URL" = var.web_url } : {}
        content {
          name  = env.key
          value = env.value
        }
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
