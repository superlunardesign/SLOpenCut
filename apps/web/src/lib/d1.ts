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

interface D1ApiResponse<T> {
	result: Array<{
		results: T[];
		success: boolean;
	}>;
	success: boolean;
	errors: Array<{ code: number; message: string }>;
	messages: string[];
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

	const rawText = await res.text();

	if (!res.ok) {
		throw new Error(`D1 query failed: ${res.status} ${rawText}`);
	}

	const wrapper = JSON.parse(rawText) as D1ApiResponse<T>;

	if (!wrapper.success) {
		const msg = wrapper.errors?.[0]?.message ?? rawText;
		throw new Error(`D1 error: ${msg}`);
	}

	return wrapper.result?.[0]?.results ?? [];
}
