-- Persist the exact cost-accounting split required by SPEC §38.14.
-- `cost_micros` remains for legacy readers; new writers use the bigint fields
-- and identify whether the value is provider-reported, economics-computed, or
-- unavailable. A catalog-derived value is never presented as provider spend.

ALTER TABLE provider_attempts
ADD COLUMN provider_reported_cost_micros INTEGER;

ALTER TABLE provider_attempts
ADD COLUMN computed_cost_micros INTEGER;

ALTER TABLE provider_attempts
ADD COLUMN cost_source TEXT
CHECK (cost_source IS NULL OR cost_source IN (
    'provider_reported',
    'admitted_economics',
    'free_model_contract',
    'unavailable'
));
