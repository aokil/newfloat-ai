export const REFERRAL_TABLES = ['referral_codes','referral_attributions','referral_earnings','referral_periods','referral_cash_operations'];

// Values in the cash ledger are exact quarter-fen. Positive charges hold or spend that balance.
export const REFERRAL_SCHEMA = `
CREATE TABLE referral_codes(owner_id TEXT PRIMARY KEY REFERENCES users(id), code TEXT NOT NULL UNIQUE);
CREATE TABLE referral_attributions(friend_id TEXT PRIMARY KEY REFERENCES users(id), owner_id TEXT NOT NULL REFERENCES users(id),
  registered_at BIGINT NOT NULL, period_start BIGINT NOT NULL, CHECK(friend_id<>owner_id));
CREATE INDEX referral_attributions_owner_period ON referral_attributions(owner_id,period_start,registered_at);
CREATE TABLE referral_earnings(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), friend_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('commission','daily')), units BIGINT NOT NULL CHECK(units>0), created_at BIGINT NOT NULL);
CREATE INDEX referral_earnings_owner ON referral_earnings(owner_id,friend_id);
CREATE TABLE referral_periods(owner_id TEXT NOT NULL REFERENCES users(id), period_start BIGINT NOT NULL,
  registrations INTEGER NOT NULL, paid INTEGER NOT NULL, settled_at BIGINT NOT NULL, PRIMARY KEY(owner_id,period_start));
CREATE TABLE referral_cash_operations(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('withdrawal','exchange')), units BIGINT NOT NULL CHECK(units>0),
  status TEXT NOT NULL CHECK(status IN ('pending','processed')), qr_cipher TEXT, created_at BIGINT NOT NULL,
  processed_at BIGINT, processed_by TEXT REFERENCES users(id), UNIQUE(owner_id,request_key));
CREATE INDEX referral_cash_operations_owner ON referral_cash_operations(owner_id,kind,created_at);
CREATE INDEX referral_cash_operations_queue ON referral_cash_operations(kind,status,created_at);
`;
