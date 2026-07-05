import type { DomainDictionary } from "./types.js";

// Base banking / fintech dictionary (Plan 11, Pillar C).
export const BANKING: DomainDictionary = {
  domain: "banking",
  label: "Banking",
  features: [
    // ── Accounts ─────────────────────────────────────────────────────────────
    { canonical: "Account", category: "Accounts", keywords: ["account", "accounts", "savings", "checking", "current", "wallet"] },
    { canonical: "Balance", category: "Accounts", keywords: ["balance", "ledger", "available"] },
    { canonical: "Statement", category: "Accounts", keywords: ["statement", "statements", "history", "activity"] },
    { canonical: "Interest", category: "Accounts", keywords: ["interest", "apr", "apy", "rate"] },

    // ── Payments & Transfers ─────────────────────────────────────────────────
    { canonical: "Transaction", category: "Payments & Transfers", keywords: ["transaction", "transactions", "txn", "posting", "entry"] },
    { canonical: "Transfer", category: "Payments & Transfers", keywords: ["transfer", "transfers", "remittance", "wire", "ach", "swift"] },
    { canonical: "Payment", category: "Payments & Transfers", keywords: ["payment", "payments", "billpay", "standingorder", "directdebit"] },
    { canonical: "Beneficiary", category: "Payments & Transfers", keywords: ["beneficiary", "payee", "recipient"] },
    { canonical: "Deposit", category: "Payments & Transfers", keywords: ["deposit", "withdrawal", "cash"] },

    // ── Cards ────────────────────────────────────────────────────────────────
    { canonical: "Card", category: "Cards", keywords: ["card", "cards", "debit", "creditcard", "atm", "pin"] },

    // ── Lending ──────────────────────────────────────────────────────────────
    { canonical: "Loan", category: "Lending", keywords: ["loan", "loans", "lending", "mortgage", "emi", "installment"] },
    { canonical: "Credit", category: "Lending", keywords: ["credit", "creditline", "creditscore", "limit"] },

    // ── Customer & Compliance ────────────────────────────────────────────────
    { canonical: "Customer", category: "Customer", keywords: ["customer", "accountholder", "profile", "user"] },
    { canonical: "KYC", category: "Compliance", keywords: ["kyc", "onboarding", "verification", "identity", "document"] },
    { canonical: "Fraud & AML", category: "Compliance", keywords: ["fraud", "aml", "sanction", "sanctions", "risk", "monitoring", "alert"] },
    { canonical: "Authentication", category: "Customer", keywords: ["auth", "login", "otp", "mfa", "session", "token"] },
  ],
};
