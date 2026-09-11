import { describe, expect, it } from "vitest";
import { wrapPsqlInRollback } from "./engine.js";

describe("wrapPsqlInRollback", () => {
    it("wraps a double-quoted -c payload in BEGIN … ROLLBACK", () => {
        const cmd = `PGPASSWORD="$PW" psql -h localhost -p 5433 -U app -d app_db -v ON_ERROR_STOP=1 -c "UPDATE funding_source SET x = 1 WHERE name = 'Loan A'"`;
        expect(wrapPsqlInRollback(cmd)).toBe(`PGPASSWORD="$PW" psql -h localhost -p 5433 -U app -d app_db -v ON_ERROR_STOP=1 -c "BEGIN; UPDATE funding_source SET x = 1 WHERE name = 'Loan A'; ROLLBACK;"`);
    });
    it("wraps a single-quoted payload and drops a trailing semicolon", () => {
        expect(wrapPsqlInRollback(`psql -d dev -c 'INSERT INTO t (a) VALUES (1);'`)).toBe(`psql -d dev -c 'BEGIN; INSERT INTO t (a) VALUES (1); ROLLBACK;'`);
    });
    it("keeps escaped quotes inside the payload", () => {
        expect(wrapPsqlInRollback(`psql -c "SELECT \\"user\\".id FROM \\"user\\""`)).toBe(`psql -c "BEGIN; SELECT \\"user\\".id FROM \\"user\\"; ROLLBACK;"`);
    });
    it("leaves payloads that already open a transaction, and meta-commands, alone", () => {
        expect(wrapPsqlInRollback(`psql -c "BEGIN; UPDATE t SET a=1; COMMIT;"`)).toBe(`psql -c "BEGIN; UPDATE t SET a=1; COMMIT;"`);
        expect(wrapPsqlInRollback(`psql -c '\\d deals'`)).toBe(`psql -c '\\d deals'`);
    });
    it("returns the command unchanged without a -c payload", () => {
        expect(wrapPsqlInRollback(`psql -d dev -f seed.sql`)).toBe(`psql -d dev -f seed.sql`);
    });
});
