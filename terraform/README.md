# Terraform Google Cloud Run with Private Cloud SQL

This Terraform configuration deploys a Google Cloud Run service that securely connects to a Google Cloud SQL (PostgreSQL) instance using a private IP address. It leverages a VPC network and Private Service Connect to ensure that the database is not exposed to the public internet. Database credentials are not hardcoded, and are stored and accessed securely using Google Secret Manager.

## Architecture

The architecture consists of the following components:

- **Google Cloud Run:** A fully managed serverless platform for containerized applications.
- **Google Cloud SQL:** A fully managed relational database service. The instance is configured with a private IP address and is not publicly accessible.
- **VPC Network:** A Virtual Private Cloud network to provide a private and isolated environment for the resources.
- **Private Service Connect:** Enables private consumption of services across VPC networks. In this case, it allows Cloud Run to connect to the Cloud SQL instance over a private connection.
- **Serverless VPC Access Connector:** Connects the Cloud Run service to the VPC network.
- **Google Secret Manager:** Stores the database username and password securely.

## Prerequisites

- [Terraform](https://learn.hashicorp.com/tutorials/terraform/install-cli) installed
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed and authenticated
- A Google Cloud project with billing enabled

## How to Use

1. **Clone the repository.**

2. **Navigate to the `terraform` directory.**

   ```bash
   cd terraform
   ```

3. **Create a `terraform.tfvars` file.**

   Create a file named `terraform.tfvars` and add the following content, replacing `<YOUR_PROJECT_ID>` with your Google Cloud project ID:

   ```hcl
   project_id = "<YOUR_PROJECT_ID>"
   ```

4. **Initialize Terraform.**

   ```bash
   terraform init
   ```

5. **Format the Terraform code.**

   ```bash
   terraform fmt
   ```

6. **Apply the Terraform configuration.**

   ```bash
   terraform apply
   ```

   Terraform will show you a plan of the resources to be created. Type `yes` to confirm and apply the changes.

7. **Access the Cloud Run service.**

   Once the deployment is complete, Terraform will output the URL of the Cloud Run service. You can access this URL in your browser to see the "Hello World" application.

8. **Clean up.**

   To destroy the resources created by this configuration, run the following command:

   ```bash
   terraform destroy
   ```

   Type `yes` to confirm and destroy the resources.
