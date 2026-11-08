import { Validator, type Schema } from "@cfworker/json-schema";
import schema from "../../schema/v1.json";

export interface MarketplaceUpdateQuery {
  api_revisions: string;
  host_revision: string;
  current_version: string;
  current_sha256: string;
}

const queryValidator = new Validator({ $ref: `${schema.$id}#/$defs/MarketplaceUpdateQuery` }, "2020-12");
queryValidator.addSchema(schema as unknown as Schema);

/** Requires full host/digest identities, a stable installed version and at most 32 full supported API revisions. */
export function isMarketplaceUpdateQuery(value: unknown): value is MarketplaceUpdateQuery {
  return value !== undefined && queryValidator.validate(value).valid;
}
