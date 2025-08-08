# Deploying to Google Cloud Platform

This document provides instructions for deploying the application to Google Cloud Platform, using Cloud SQL for the database and Cloud Storage for object storage.

## 1. Set up Google Cloud SQL

1.  **Create a Cloud SQL for MySQL instance:**
    *   Go to the [Cloud SQL instances page](https://console.cloud.google.com/sql/instances) in the Google Cloud Console.
    *   Click "Create instance".
    *   Choose "MySQL".
    *   Provide an instance ID (e.g., `cap-mysql-instance`).
    *   Set a strong root password.
    *   Choose the desired region and zone.
    *   For the initial setup, you can use the default settings. You can customize them later based on your performance and availability needs.
    *   Click "Create".

2.  **Create a database:**
    *   Once the instance is created, go to the "Databases" tab for your instance.
    *   Click "Create database".
    *   Enter `planetscale` as the database name. This is the name the application expects.

3.  **Configure networking:**
    *   For connecting from a local machine or a non-GCP service, you'll need to configure public IP access.
    *   Go to the "Connections" tab for your instance.
    *   Under "Public IP", check "Public IP".
    *   Under "Authorized networks", click "Add network" and add the IP address of the machine you'll be connecting from. For testing, you can add `0.0.0.0/0` to allow all IPs, but **this is not recommended for production**.
    *   If you are deploying the application to a GCP service like Cloud Run or GKE, it's recommended to use the Cloud SQL Auth Proxy for secure connections. Refer to the [Cloud SQL Auth Proxy documentation](https://cloud.google.com/sql/docs/mysql/connect-auth-proxy) for more information.

4.  **Get the database connection string:**
    *   Your `DATABASE_URL` will be in the following format:
        ```
        mysql://<USER>:<PASSWORD>@<PUBLIC_IP_ADDRESS>/planetscale
        ```
    *   Replace `<USER>` with `root`.
    *   Replace `<PASSWORD>` with the password you set when creating the instance.
    *   Replace `<PUBLIC_IP_ADDRESS>` with the public IP address of your Cloud SQL instance (found on the "Overview" tab).

## 2. Set up Google Cloud Storage

1.  **Create a Cloud Storage bucket:**
    *   Go to the [Cloud Storage browser](https://console.cloud.google.com/storage/browser) in the Google Cloud Console.
    *   Click "Create bucket".
    *   Give the bucket a unique name (e.g., `cap-storage-bucket`).
    *   Choose a location for your bucket.
    *   Choose a storage class (e.g., "Standard").
    *   For "Access control", choose "Fine-grained".
    *   Click "Create".

2.  **Create a service account and key:**
    *   Go to the [Service accounts page](https://console.cloud.google.com/iam-admin/serviceaccounts).
    *   Click "Create service account".
    *   Give the service account a name (e.g., `cap-storage-service-account`).
    *   Grant the service account the "Storage Admin" role (`roles/storage.admin`).
    *   Click "Done".
    *   Find the service account you just created, click the three dots under "Actions", and select "Manage keys".
    *   Click "Add key" -> "Create new key".
    *   Choose "JSON" as the key type and click "Create". A JSON file will be downloaded to your computer.

3.  **Set the environment variables:**
    *   `CAP_AWS_ACCESS_KEY`: The `client_email` from the downloaded JSON key file.
    *   `CAP_AWS_SECRET_KEY`: The `private_key` from the downloaded JSON key file.
    *   `CAP_AWS_BUCKET`: The name of your Cloud Storage bucket.
    *   `CAP_AWS_REGION`: The region of your bucket (e.g., `us-central1`).
    *   `S3_PUBLIC_ENDPOINT`: `https://storage.googleapis.com/<YOUR_BUCKET_NAME>`
    *   `S3_INTERNAL_ENDPOINT`: `https://storage.googleapis.com`

## 3. Configure the Application

Set the following environment variables in your application's deployment environment (e.g., Cloud Run, GKE, or your `.env` file for local development):

```
# Google Cloud SQL
DATABASE_URL="mysql://root:<YOUR_DB_PASSWORD>@<YOUR_DB_PUBLIC_IP>/planetscale"

# Google Cloud Storage
CAP_AWS_ACCESS_KEY="<YOUR_SERVICE_ACCOUNT_EMAIL>"
CAP_AWS_SECRET_KEY="<YOUR_SERVICE_ACCOUNT_PRIVATE_KEY>"
CAP_AWS_BUCKET="<YOUR_BUCKET_NAME>"
CAP_AWS_REGION="<YOUR_BUCKET_REGION>"
S3_PUBLIC_ENDPOINT="https://storage.googleapis.com/<YOUR_BUCKET_NAME>"
S3_INTERNAL_ENDPOINT="https://storage.googleapis.com"

# Other required variables (see .env.example)
WEB_URL="http://localhost:3000" # Change to your production URL
NEXTAUTH_URL="http://localhost:3000" # Change to your production URL
DATABASE_ENCRYPTION_KEY="<generate a random 32-byte hex string>"
NEXTAUTH_SECRET="<generate a random string>"
```

After setting these environment variables, you can deploy the application to your chosen Google Cloud service. Remember to run the database migrations after the first deployment to set up the schema in your Cloud SQL database. You can do this by running `pnpm db:push` in the application's environment.
