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
  description = "A map of services to deploy, where the key is the service name and the value is an object containing the image URL."
  type = map(object({
    image_url = string
  }))
}
