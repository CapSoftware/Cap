terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 4.0.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_project_service" "project_services" {
  for_each = toset([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "compute.googleapis.com",
    "servicenetworking.googleapis.com",
    "secretmanager.googleapis.com",
    "vpcaccess.googleapis.com"
  ])
  service                    = each.key
  disable_dependency_handling = false
}

module "vpc" {
  source     = "./modules/vpc"
  project_id = var.project_id
  region     = var.region
  network_name = "private-net"
}

module "cloud_sql" {
  source     = "./modules/cloud-sql"
  project_id = var.project_id
  region     = var.region
  network_id = module.vpc.network_id
  db_user = "db_user"
}

module "cloud_run" {
  for_each = var.services

  source           = "./modules/cloud-run"
  project_id       = var.project_id
  region           = var.region
  service_name     = each.key
  image_url        = each.value.image_url
  db_connection_name = module.cloud_sql.db_instance_connection_name
  db_name          = module.cloud_sql.db_name
  db_user_secret_id = module.cloud_sql.db_user_secret_id
  db_password_secret_id = module.cloud_sql.db_password_secret_id
  vpc_connector_id = module.vpc.vpc_connector_id
}
