// Capital One Nessie (sandbox): customers, accounts, purchases, merchants, transfers.
// Without NESSIE_API_KEY an in-memory stand-in with the same shape is used (terminal and sim only).
import { config, hasNessie } from "../config.ts";

export type NCustomer = { id: string; firstName: string; lastName: string };
export type NAccount = { id: string; customerId: string; nickname: string; balance: number };
export type NMerchant = { id: string; name: string; category: string[]; lat?: number; lng?: number };
export type NPurchase = { id: string; accountId: string; merchantId: string; amount: number; date: string; description: string };

export interface Bank {
  readonly real: boolean;
  listCustomers(): Promise<NCustomer[]>;
  createCustomer(firstName: string, lastName: string): Promise<NCustomer>;
  accounts(customerId: string): Promise<NAccount[]>;
  createAccount(customerId: string, nickname: string, balance: number): Promise<NAccount>;
  purchases(accountId: string): Promise<NPurchase[]>;
  createPurchase(accountId: string, merchantId: string, amount: number, date: string, description: string): Promise<NPurchase>;
  merchant(id: string): Promise<NMerchant | null>;
  createMerchant(name: string, category: string[], lat?: number, lng?: number): Promise<NMerchant>;
  transfer(fromAccountId: string, toAccountId: string, amount: number, date: string, description: string): Promise<{ ok: boolean; id?: string; error?: string }>;
}

const RESTAURANT = /food|restaurant|dining|cafe|bar|eat/i;
export const isRestaurant = (m: NMerchant | null) => Boolean(m && m.category.some((c) => RESTAURANT.test(c)));

// ---------------------------------------------------------------------------------------------

class NessieApi implements Bank {
  readonly real = true;
  private merchants = new Map<string, NMerchant | null>();

  private url(path: string) {
    return `${config.nessie.baseUrl}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(config.nessie.apiKey!)}`;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      headers: body ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Nessie ${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async listCustomers(): Promise<NCustomer[]> {
    const rows = await this.req<{ _id: string; first_name: string; last_name: string }[]>("GET", "/customers");
    return rows.map((r) => ({ id: r._id, firstName: r.first_name, lastName: r.last_name }));
  }

  async createCustomer(firstName: string, lastName: string): Promise<NCustomer> {
    const res = await this.req<{ objectCreated: { _id: string } }>("POST", "/customers", {
      first_name: firstName,
      last_name: lastName,
      address: { street_number: "100", street_name: "Franklin St", city: "Chapel Hill", state: "NC", zip: "27514" },
    });
    return { id: res.objectCreated._id, firstName, lastName };
  }

  async accounts(customerId: string): Promise<NAccount[]> {
    const rows = await this.req<{ _id: string; customer_id: string; nickname: string; balance: number }[]>("GET", `/customers/${customerId}/accounts`);
    return rows.map((r) => ({ id: r._id, customerId: r.customer_id, nickname: r.nickname, balance: r.balance }));
  }

  async createAccount(customerId: string, nickname: string, balance: number): Promise<NAccount> {
    const res = await this.req<{ objectCreated: { _id: string } }>("POST", `/customers/${customerId}/accounts`, {
      type: "Checking",
      nickname,
      rewards: 0,
      balance,
    });
    return { id: res.objectCreated._id, customerId, nickname, balance };
  }

  async purchases(accountId: string): Promise<NPurchase[]> {
    const rows = await this.req<{ _id: string; merchant_id: string; amount: number; purchase_date: string; description?: string }[]>(
      "GET",
      `/accounts/${accountId}/purchases`,
    );
    return rows.map((r) => ({ id: r._id, accountId, merchantId: r.merchant_id, amount: r.amount, date: r.purchase_date, description: r.description ?? "" }));
  }

  async createPurchase(accountId: string, merchantId: string, amount: number, date: string, description: string): Promise<NPurchase> {
    const res = await this.req<{ objectCreated: { _id: string } }>("POST", `/accounts/${accountId}/purchases`, {
      merchant_id: merchantId,
      medium: "balance",
      purchase_date: date,
      amount,
      description,
    });
    return { id: res.objectCreated._id, accountId, merchantId, amount, date, description };
  }

  async merchant(id: string): Promise<NMerchant | null> {
    if (this.merchants.has(id)) return this.merchants.get(id)!;
    try {
      const r = await this.req<{ _id: string; name: string; category?: string[] | string; geocode?: { lat: number; lng: number } }>("GET", `/merchants/${id}`);
      const m: NMerchant = {
        id: r._id,
        name: r.name,
        category: Array.isArray(r.category) ? r.category : r.category ? [r.category] : [],
        lat: r.geocode?.lat,
        lng: r.geocode?.lng,
      };
      this.merchants.set(id, m);
      return m;
    } catch {
      this.merchants.set(id, null);
      return null;
    }
  }

  async createMerchant(name: string, category: string[], lat?: number, lng?: number): Promise<NMerchant> {
    const res = await this.req<{ objectCreated: { _id: string } }>("POST", "/merchants", {
      name,
      category,
      address: { street_number: "1", street_name: "Franklin St", city: "Chapel Hill", state: "NC", zip: "27514" },
      geocode: { lat: lat ?? 35.9132, lng: lng ?? -79.0558 },
    });
    const m = { id: res.objectCreated._id, name, category, lat, lng };
    this.merchants.set(m.id, m);
    return m;
  }

  async transfer(fromAccountId: string, toAccountId: string, amount: number, date: string, description: string) {
    try {
      const res = await this.req<{ objectCreated?: { _id: string } }>("POST", `/accounts/${fromAccountId}/transfers`, {
        medium: "balance",
        payee_id: toAccountId,
        amount,
        transaction_date: date,
        description,
      });
      return { ok: true, id: res.objectCreated?._id };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}

// ---------------------------------------------------------------------------------------------

export class MemoryBank implements Bank {
  readonly real = false;
  customers = new Map<string, NCustomer>();
  accountRows = new Map<string, NAccount>();
  merchantRows = new Map<string, NMerchant>();
  purchaseRows: NPurchase[] = [];
  transfers: { id: string; from: string; to: string; amount: number }[] = [];
  private n = 0;
  private id(prefix: string) {
    this.n += 1;
    return `${prefix}${String(this.n).padStart(6, "0")}`;
  }

  async listCustomers() {
    return [...this.customers.values()];
  }
  async createCustomer(firstName: string, lastName: string) {
    const c = { id: this.id("cust"), firstName, lastName };
    this.customers.set(c.id, c);
    return c;
  }
  async accounts(customerId: string) {
    return [...this.accountRows.values()].filter((a) => a.customerId === customerId);
  }
  async createAccount(customerId: string, nickname: string, balance: number) {
    const a = { id: this.id("acct"), customerId, nickname, balance };
    this.accountRows.set(a.id, a);
    return a;
  }
  async purchases(accountId: string) {
    return this.purchaseRows.filter((p) => p.accountId === accountId);
  }
  async createPurchase(accountId: string, merchantId: string, amount: number, date: string, description: string) {
    const p = { id: this.id("purch"), accountId, merchantId, amount, date, description };
    this.purchaseRows.push(p);
    const a = this.accountRows.get(accountId);
    if (a) a.balance -= amount;
    return p;
  }
  async merchant(id: string) {
    return this.merchantRows.get(id) ?? null;
  }
  async createMerchant(name: string, category: string[], lat?: number, lng?: number) {
    const m = { id: this.id("merch"), name, category, lat, lng };
    this.merchantRows.set(m.id, m);
    return m;
  }
  async transfer(fromAccountId: string, toAccountId: string, amount: number) {
    const from = this.accountRows.get(fromAccountId);
    const to = this.accountRows.get(toAccountId);
    if (!from || !to) return { ok: false, error: "unknown account" };
    from.balance -= amount;
    to.balance += amount;
    const id = this.id("xfer");
    this.transfers.push({ id, from: fromAccountId, to: toAccountId, amount });
    return { ok: true, id };
  }
}

let instance: Bank | null = null;
export function bank(): Bank {
  if (!instance) instance = hasNessie() ? new NessieApi() : new MemoryBank();
  return instance;
}
export function setBankForTests(b: Bank): void {
  instance = b;
}
