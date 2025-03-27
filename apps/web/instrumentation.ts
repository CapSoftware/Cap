// This file is used to run database migrations in the docker builds or other self hosting environments.
// It is not suitable (a.k.a DEADLY) for serverless environments where the server will be restarted on each request.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    console.log("Waiting 5 seconds to run database migrations");

    // Function to trigger migrations with retry logic
    const triggerMigrations = async (retryCount = 0, maxRetries = 3) => {
      try {
        const response = await fetch(
          "http://localhost:3000/api/selfhosted/migrations",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
          }
        );

        // This will throw an error if the response status is not ok
        response.ok ||
          (await Promise.reject(new Error(`HTTP error ${response.status}`)));

        const responseData = await response.json();
        console.log(
          "✅ Migrations triggered successfully:",
          responseData.message
        );
      } catch (error) {
        console.error(
          `🚨 Error triggering migrations (attempt ${retryCount + 1}):`,
          error
        );
        if (retryCount < maxRetries - 1) {
          console.log(
            `🔄 Retrying in 5 seconds... (${retryCount + 1}/${maxRetries})`
          );
          setTimeout(() => triggerMigrations(retryCount + 1, maxRetries), 5000);
        } else {
          console.error(`🚨 All ${maxRetries} migration attempts failed.`);
          process.exit(1); // Exit with error code if all attempts fail
        }
      }
    };

    // Add a timeout to trigger migrations after 5 seconds on server start
    setTimeout(() => triggerMigrations(), 5000);
  }
  return;
}
