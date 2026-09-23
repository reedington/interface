-- PostgreSQL's entrypoint runs this only when the named database volume is empty.
-- Fineract creates and migrates the tenant tables itself on first startup.
CREATE DATABASE fineract_default OWNER fineract;
