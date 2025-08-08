variable "project_id" {
  description = "The project ID to host the resources in."
  type        = string
}

variable "region" {
  description = "The region to host the resources in."
  type        = string
}

variable "service_name" {
  description = "The name of the Cloud Run service."
  type        = string
}

variable "db_connection_name" {
  description = "The connection name of the database instance."
  type        = string
}

variable "db_name" {
  description = "The name of the database."
  type        = string
}

variable "db_user_secret_id" {
  description = "The ID of the secret for the database user."
  type        = string
}

variable "db_password_secret_id" {
  description = "The ID of the secret for the database password."
  type        = string
}

variable "vpc_connector_id" {
    description = "The ID of the VPC connector"
    type = string
}
