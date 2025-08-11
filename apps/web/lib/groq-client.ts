import Groq from "groq-sdk";
import { serverEnv } from "@cap/env";

let groqClient: Groq | null = null;

export function getGroqClient(): Groq | null {
  if (!serverEnv().GROQ_API_KEY) {
    return null;
  }
  
  if (!groqClient) {
    groqClient = new Groq({ 
      apiKey: serverEnv().GROQ_API_KEY 
    });
  }
  
  return groqClient;
}

export const GROQ_MODEL = "meta-llama/llama-4-maverick-17b-128e-instruct";