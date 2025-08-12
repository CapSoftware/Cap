resource "google_compute_network" "main" {
  project                 = var.project_id
  name                    = var.network_name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "main" {
  project       = var.project_id
  name          = "${var.network_name}-subnet"
  ip_cidr_range = "10.0.0.0/28"
  network       = google_compute_network.main.id
  region        = var.region
}

resource "google_compute_global_address" "private_ip_address" {
  project       = var.project_id
  name          = "private-ip-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "private_service_access" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip_address.name]
}

resource "google_vpc_access_connector" "main" {
  project        = var.project_id
  name           = "${var.network_name}-connector"
  region         = var.region
  ip_cidr_range  = "10.8.0.0/28"
  network        = google_compute_network.main.name

  depends_on = [
    google_service_networking_connection.private_service_access
  ]
}
