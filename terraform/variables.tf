variable "project_id" {
  description = "The project ID to host the resources in."
  type        = string
}

variable "region" {
  description = "The region to host the resources in."
  type        = string
  default     = "us-central1"
}
