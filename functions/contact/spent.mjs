// Remembers ALTCHA solutions already used, so each one files at most one message.
// One DynamoDB item per spent challenge signature, deleted by TTL once the challenge has expired.
import { ConditionalCheckFailedException, DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';

let client;

/**
 * Records `signature` as spent until `expiresAt` (Unix seconds).
 * Resolves true the first time, false when it was already spent. Throws when the store fails.
 * @param {string} signature
 * @param {number} expiresAt
 */
export async function spend(signature, expiresAt) {
  client ??= new DynamoDBClient({});
  try {
    await client.send(
      new PutItemCommand({
        TableName: process.env.SPENT_TABLE,
        Item: { signature: { S: signature }, expiresAt: { N: String(expiresAt) } },
        ConditionExpression: 'attribute_not_exists(signature)',
      }),
      // A store that hangs must fail fast, so the caller can accept the message unrecorded.
      { abortSignal: AbortSignal.timeout(2_000) },
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}
