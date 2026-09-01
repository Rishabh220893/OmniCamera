import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { LogSentiment } from "../types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const SENTIMENT_EMOJI: Record<LogSentiment, string> = {
  calm: '🙂',
  neutral: '😐',
  tense: '😟',
  critical: '🚨',
};

export function sentimentEmoji(sentiment?: LogSentiment): string {
  return sentiment ? SENTIMENT_EMOJI[sentiment] : SENTIMENT_EMOJI.neutral;
}
