import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { webEnv } from "@/env/web";

const rateLimit =
	webEnv.UPSTASH_REDIS_REST_URL && webEnv.UPSTASH_REDIS_REST_TOKEN
		? new Ratelimit({
				redis: new Redis({
					url: webEnv.UPSTASH_REDIS_REST_URL,
					token: webEnv.UPSTASH_REDIS_REST_TOKEN,
				}),
				limiter: Ratelimit.slidingWindow(100, "1 m"),
				analytics: true,
				prefix: "rate-limit",
			})
		: null;

export async function checkRateLimit({ request }: { request: Request }) {
	if (!rateLimit) return { success: true, limited: false };
	const ip = request.headers.get("x-forwarded-for") ?? "anonymous";
	const { success } = await rateLimit.limit(ip);
	return { success, limited: !success };
}
