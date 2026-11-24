const CF_API = "https://api.cloudflare.com/client/v4";

function getD1Config() {
	const accountId =
		process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.R2_ACCOUNT_ID;
	const apiToken =
		process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
	const databaseId = process.env.CF_D1_DATABASE_ID;

	if (!accountId || !apiToken || !databaseId) {
		throw new Error("Missing Cloudflare D1 environment variables");
	}

	return { accountId, apiToken, databaseId };
}

interface D1Result<T> {
	results: T[];
	success: boolean;
	errors: { message: string }[];
}

export async function d1Query<T>(
	sql: string,
	params: (string | number | null)[] = [],
): Promise<T[]> {
	const { accountId, apiToken, databaseId } = getD1Config();

	const res = await fetch(
		`${CF_API}/accounts/${accountId}/d1/database/${databaseId}/query`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sql, params }),
		},
	);

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`D1 query failed: ${res.status} ${text}`);
	}

	const rawText = await res.text();
	let json: unknown;
	try {
		json = JSON.parse(rawText);
	} catch {
		throw new Error(`D1 response not JSON: ${rawText.slice(0, 500)}`);
	}

	// D1 REST API returns an array for the /query endpoint
	const asArray = Array.isArray(json) ? json as D1Result<T>[] : [json as D1Result<T>];
	const first = asArray[0];

	if (!first?.success) {
		// Return the full raw response so it's visible in the browser
		throw new Error(`D1 error: ${rawText}`);
	}

	return first.results;
}
