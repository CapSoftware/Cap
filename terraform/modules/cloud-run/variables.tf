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

variable "image_url" {
  description = "The URL of the Docker image to deploy."
  type        = string
}

variable "google_client_id_secret_id" {
  description = "The ID of the secret for the Google Client ID."
  type        = string
  default     = null
}

variable "google_client_secret_secret_id" {
  description = "The ID of the secret for the Google Client Secret."
  type        = string
  default     = null
}

variable "workos_client_id_secret_id" {
  description = "The ID of the secret for the WorkOS Client ID."
  type        = string
  default     = null
}

variable "workos_api_key_secret_id" {
  description = "The ID of the secret for the WorkOS API Key."
  type        = string
  default     = null
}

variable "resend_api_key_secret_id" {
  description = "The ID of the secret for the Resend API Key."
  type        = string
  default     = null
}

variable "nextauth_secret_secret_id" {
  description = "The ID of the secret for the NextAuth Secret."
  type        = string
  default     = null
}

variable "web_url" {
  description = "The public URL of the web application."
  type        = string
  default     = null
}
