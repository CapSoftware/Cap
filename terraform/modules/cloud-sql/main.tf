resource "google_sql_database_instance" "main" {
  project             = var.project_id
  name                = "private-db-instance"
  database_version    = "POSTGRES_13"
  region              = var.region

  settings {
    tier = "db-g1-small"
    ip_configuration {
      ipv4_enabled    = false
      private_network = var.network_id
    }
  }

  deletion_protection = false
}

resource "google_sql_database" "main" {
  project  = var.project_id
  instance = google_sql_database_instance.main.name
  name     = "private-db"
}

resource "random_password" "db_password" {
  length  = 16
  special = true
}

resource "google_secret_manager_secret" "db_password_secret" {
  secret_id  = "db-password"

  replication {
    automatic = {}
  }
}

resource "google_secret_manager_secret_version" "db_password_secret_version" {
  secret      = google_secret_manager_secret.db_password_secret.id
  secret_data = random_password.db_password.result
}

resource "google_secret_manager_secret" "db_user_secret" {
  secret_id  = "db-user"

  replication {
    automatic = {}
  }
}

resource "google_secret_manager_secret_version" "db_user_secret_version" {
  secret      = google_secret_manager_secret.db_user_secret.id
  secret_data = var.db_user
}

resource "google_sql_user" "main" {
  project  = var.project_id
  instance = google_sql_database_instance.main.name
  name     = var.db_user
  password = random_password.db_password.result
}
