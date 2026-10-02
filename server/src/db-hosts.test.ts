import { describe, expect, it } from "vitest";
import { allowedDbHostsOf, parseDbHosts } from "./db-hosts.js";

describe("db hosts", () => {
    it("reads host names with aliases, ports and IPv6", () => {
        expect(parseDbHosts("default=localhost:5432 replica=dev-aurora.cluster-x.us-east-1.rds.amazonaws.com:5432 x=[::1]:5432")).toEqual(["localhost", "dev-aurora.cluster-x.us-east-1.rds.amazonaws.com", "::1"]);
        expect(parseDbHosts("localhost, localhost 127.0.0.1")).toEqual(["localhost", "127.0.0.1"]);
    });
    it("defaults the allowed list to the loopback names", () => {
        expect(allowedDbHostsOf({ allowed_db_hosts: null })).toEqual(["localhost", "127.0.0.1", "::1"]);
        expect(allowedDbHostsOf({ allowed_db_hosts: '["db.local"]' })).toEqual(["db.local"]);
    });
});
