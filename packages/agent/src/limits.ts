const limit=(name:string,fallback:number)=>{
  const raw=process.env[name];if(!raw?.trim())return fallback;
  const value=Number(raw);if(!Number.isSafeInteger(value)||value<1||value>100_000)throw new Error(`Invalid ${name}`);
  return value;
};
export const aiLimits={conversationPerHour:limit('AI_MAX_REQUESTS_PER_CONVERSATION_HOUR',120),processPerHour:limit('OPENROUTER_MAX_REQUESTS_PER_HOUR',600)};
