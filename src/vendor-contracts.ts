import type { CallToolResult } from '@modelcontextprotocol/client';

export type ResultPolicy = 'mailchimp-1.2.0' | 'zendesk-0.1.6' | 'quickbooks-31a1dd5';
export const quickbooksJsonReads=new Set([
  "get_account","get_aged_payables","get_aged_receivables","get_attachable",
  "get_balance_sheet","get_bill_payment","get-bill","get_cash_flow",
  "get_class","get_company_info","get_credit_memo","get_customer_balance",
  "get_customer_sales","get_customer","get_department","get_deposit",
  "get_employee","get_estimate","get_general_ledger","get_journal_entry",
  "get_payment_method","get_payment","get_preferences","get_profit_and_loss",
  "get_purchase_order","get_purchase","get_refund_receipt","get_sales_receipt",
  "get_tax_agency","get_tax_code","get_tax_rate","get_term",
  "get_time_activity","get_transfer","get_trial_balance","get_vendor_balance",
  "get_vendor_credit","get_vendor_expenses","get-vendor","read_invoice",
  "read_item","search_accounts","search_attachables","search_bill_payments",
  "search_bills","search_budgets","search_classes","search_credit_memos",
  "search_customers","search_departments","search_deposits","search_employees",
  "search_estimates","search_invoices","search_items","search_journal_entries",
  "search_payment_methods","search_payments","search_purchase_orders","search_purchases",
  "search_refund_receipts","search_sales_receipts","search_tax_agencies","search_tax_codes",
  "search_tax_rates","search_terms","search_time_activities","search_transfers",
  "search_vendor_credits","search_vendors",
]);
export const zendeskJsonReads=new Set(['zendesk_search_tickets','zendesk_get_tickets','zendesk_get_ticket','zendesk_get_comments',
  'zendesk_list_views','zendesk_get_view','zendesk_get_view_tickets','zendesk_list_macros','zendesk_search_users',
  'zendesk_get_groups','zendesk_get_group_users','zendesk_get_organization','zendesk_list_custom_statuses','zendesk_get_time_tracking']);

export function vendorEnvironmentIssues(policy: ResultPolicy | undefined, settings: Record<string, string>): string[] {
  if(policy==='zendesk-0.1.6')return settings.ZENDESK_MCP_READ_ONLY?.trim().toLowerCase()==='true'?[]
    :['The reviewed Zendesk profile requires ZENDESK_MCP_READ_ONLY=true in the child environment. Native write operations remain unverified.'];
  return policy === 'mailchimp-1.2.0' && settings.MAILCHIMP_MAX_RETRIES?.trim() !== '0'
    ? ['The pinned Mailchimp profile requires MAILCHIMP_MAX_RETRIES=0 in the child environment to prevent hidden retries of writes.'] : [];
}

/** The pinned community server swallows API failures into null totals and empty lists.
 * Its documented list payload requires a numeric total. Keep genuine empty lists,
 * but never turn missing/error data into apparent success. This policy is opt-in.
 */
export function applyResultPolicy(policy: ResultPolicy | undefined, name: string, result: CallToolResult, service = policy==='zendesk-0.1.6'?'zendesk':policy==='quickbooks-31a1dd5'?'quickbooks':'mailchimp'): CallToolResult {
  if(policy==='quickbooks-31a1dd5'&&quickbooksJsonReads.has(name)){
    const diagnostics=(result.content??[]).filter(part=>part.type==='text').map(part=>part.text);
    // The compatibility build marks native error branches explicitly. Also catch
    // the pinned original's one-part plaintext failures; never inspect JSON fields.
    const nativeFailure=diagnostics.length===1&&/^(?:Error(?::| (?:getting|searching) [^:]+:)|Invalid criteria:)/.test(diagnostics[0]!);
    if(!result.isError&&!nativeFailure)return result;
    const auth=diagnostics.some(text=>text.includes('QuickBooks requires foreground sign-in.')
      ||text.includes('QuickBooks authorization is invalid or expired')||text.includes('invalid_grant'));
    return{isError:true,content:[{type:'text',text:auth
      ?'QuickBooks requires explicit native sign-in. Stop clients sharing the token store, run the foreground vendor auth setup, then reconnect.'
      :'QuickBooks returned an API failure. Check arguments, account permissions, connection and vendor limits; raw details are hidden.'}],
      _meta:{hstack:{service,code:auth?'AUTH_REQUIRED':'UPSTREAM_ERROR'}}};
  }
  if(policy==='zendesk-0.1.6'&&!result.isError&&zendeskJsonReads.has(name)){
    let valid=false,auth=false;
    for(const part of result.content??[])if(part.type==='text'){
      // Inspect only top-level plaintext diagnostics. Never scan ticket JSON or
      // Markdown/user content for words that could be mistaken for an error.
      try{const value:unknown=JSON.parse(part.text);if(result.content.length===1&&value&&typeof value==='object')valid=true;continue;}catch{/* native failures are plain text */}
      auth ||= /^Zendesk (?:not configured\.|authorization failed:)/.test(part.text);
    }
    if(!valid)return{isError:true,
        content:[{type:'text',text:auth?'Zendesk native authorization is missing or expired. Run vendor setup in the configured private home, then check and verify this connection.'
          :'Zendesk returned an invalid JSON read response or an API failure as ordinary text. Check arguments, account permissions, connectivity and vendor limits; raw details are hidden.'}],
        _meta:{hstack:{service,code:auth?'AUTH_REQUIRED':'UPSTREAM_ERROR'}}};
    return result;
  }
  if (policy !== 'mailchimp-1.2.0' || result.isError || !['list_audiences','list_campaigns'].includes(name)) return result;
  const field = name === 'list_audiences' ? 'audiences' : 'campaigns';
  const candidates: unknown[] = [result.structuredContent];
  for (const item of result.content ?? []) if (item.type === 'text') {
    try { candidates.push(JSON.parse(item.text)); } catch { /* malformed payload must not prove success */ }
  }
  const valid = candidates.some((value) => !!value && typeof value === 'object' && 'total_items' in value
    && typeof value.total_items === 'number' && Number.isSafeInteger(value.total_items) && value.total_items >= 0
    && field in value && Array.isArray((value as Record<string, unknown>)[field]) && !('error' in value));
  if (valid) return result;
  return {
    isError:true,
    content:[{ type:'text', text:'Mailchimp returned an invalid list response. The upstream MCP may have hidden an API failure. Check API key, permissions and connectivity; do not treat this as an empty account.' }],
    _meta:{ hstack:{ service, code:'UPSTREAM_ERROR' } },
  };
}
