variable "project_id" {
  description = "The project ID to host the resources in."
  type        = string
}

variable "region" {
  description = "The region to host the resources in."
  type        = string
  default     = "us-central1"
}

variable "services" {
  description = "A map of services to deploy."
  type = map(object({
    image_url                       = string
    google_client_id_secret_id      = optional(string)
    google_client_secret_secret_id  = optional(string)
    workos_client_id_secret_id      = optional(string)
    workos_api_key_secret_id        = optional(string)
    resend_api_key_secret_id        = optional(string)
    nextauth_secret_secret_id       = optional(string)
    web_url                         = optional(string)
  }))
}
