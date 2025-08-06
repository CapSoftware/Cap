# Effect Platform HTTP Module Summary

## HTTP Module Overview

The Effect Platform's HTTP module provides a declarative and flexible way to define HTTP APIs through a hierarchical structure:

1. **HttpEndpoint**: Individual endpoints defined with a path, HTTP method, and schemas for requests and responses
2. **HttpApiGroup**: Collections of related endpoints
3. **HttpApi**: Top-level container that combines multiple groups into a complete API

## Key Features

1. **Single Definition, Multiple Uses**: The same API definition can be used for:
   - Implementing and serving endpoints
   - Generating Swagger documentation
   - Creating fully-typed API clients

2. **Schema-Based Validation**: Uses Effect's Schema for validating and parsing request/response data

3. **Flexible Path Parameters**: Support for dynamic URL segments with type safety

4. **Middleware Support**: Can add functionality like logging, authentication, or CORS

5. **Error Handling**: Built-in error types and customizable error responses

## Practical Implementation Flow

1. **Define API structure** using HttpEndpoint, HttpApiGroup, and HttpApi
2. **Implement handlers** for each endpoint using HttpApiBuilder
3. **Add middleware** as needed for cross-cutting concerns
4. **Serve the API** with auto-generated Swagger documentation
5. **Generate clients** to consume the API

## Example Usage

```typescript
// Define API structure
const MyApi = HttpApi.make("MyApi").add(
  HttpApiGroup.make("Greetings").add(
    HttpApiEndpoint.get("hello-world")`/`.addSuccess(Schema.String)
  )
)

// Implement handlers
const GreetingsLive = HttpApiBuilder.group(MyApi, "Greetings", (handlers) =>
  handlers.handle("hello-world", () => Effect.succeed("Hello, World!"))
)

// Provide implementation and serve
const MyApiLive = HttpApiBuilder.api(MyApi).pipe(Layer.provide(GreetingsLive))
const ServerLive = HttpApiBuilder.serve().pipe(
  Layer.provide(HttpApiSwagger.layer()),
  Layer.provide(MyApiLive),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)

// Launch server
Layer.launch(ServerLive).pipe(NodeRuntime.runMain)
```

This approach ensures consistency between server implementation, documentation, and client usage, reducing maintenance overhead and making APIs easier to evolve.