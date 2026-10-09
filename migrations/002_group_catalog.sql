CREATE TABLE group_catalog_variants (
  id uuid PRIMARY KEY,
  product_id text NOT NULL,
  namespace text NOT NULL,
  country text NOT NULL,
  currency text NOT NULL,
  merchant_key text NOT NULL,
  provider_product_id text NOT NULL,
  provider_variant_id text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (namespace, country, currency, merchant_key, provider_product_id, provider_variant_id)
);
CREATE TABLE group_catalog_cursors (
  id uuid PRIMARY KEY,
  namespace text NOT NULL,
  context_hash text NOT NULL,
  cursor_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL
);
REVOKE ALL ON group_catalog_variants, group_catalog_cursors FROM PUBLIC;
ALTER TABLE group_catalog_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_catalog_cursors ENABLE ROW LEVEL SECURITY;
