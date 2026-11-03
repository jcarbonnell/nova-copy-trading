/**
 * member-ops.ts: the seller's MemberOps (membership.ts) over nova-sdk-js 1.4.0 in wallet mode, signed by the
 * seller agent through the vendored nova-agent-connect (connectNovaAgent → { nova, signer }).
 *
 *   isMember → nova.isAuthorized(group, account): the contract's free is_authorized view. The account is always
 *              passed: the SDK defaults a missing one to its OWN account (the seller), which is always a member.
 *   add      → nova.addGroupMember(group, account): add_group_member signed by the seller, then the SDK's MCP
 *              follow-up. Never with accessMinutes (wallet-owned groups refuse it; expiry is ours, membership.ts).
 *   revoke   → nova.revokeGroupMember(group, account): revoke_group_member, then MCP rotates the group key.
 * Before every write, signer.resolvePending() settles a write a crash left in flight, so nothing is resent; a
 * NativeCallPendingError is rethrown and the ledger record stays as it was (membership.ts repairs it next pass).
 *
 * sellerSignerOptions fixes what the seller's runner may sign (approved 2026-11-03): upload, add, revoke, each
 * under 0.01 NEAR, below revision 5's 0.06 NEAR wNEAR cap. It cannot register, tombstone, set retention or join.
 */
import type { MemberOps } from '../core/membership.ts';
import type { AgentSignerOptions, NovaWriteMethod, PendingStore } from '../vendor/nova-agent-connect.ts';

export const SELLER_METHODS: readonly NovaWriteMethod[] = ['record_transaction', 'add_group_member', 'revoke_group_member'];
export const SELLER_MAX_DEPOSIT_YOCTO = 10n ** 22n; // 0.01 NEAR

export function sellerSignerOptions(store: PendingStore): AgentSignerOptions {
  return { store, maxDepositYocto: SELLER_MAX_DEPOSIT_YOCTO, methods: SELLER_METHODS };
}

/** The nova-sdk-js methods used (a NovaSdk from connectNovaAgent, or a fake in the harness). */
export interface MemberClient {
  isAuthorized(groupId: string, userId?: string): Promise<unknown>;
  addGroupMember(groupId: string, memberId: string, options?: unknown): Promise<unknown>;
  revokeGroupMember(groupId: string, memberId: string): Promise<unknown>;
}
export interface PendingResolver { resolvePending(): Promise<unknown> }

const need = (groupId: string, account: string) => {
  if (typeof groupId !== 'string' || groupId.length === 0) throw new Error('member-ops: a group id is required');
  if (typeof account !== 'string' || account.length === 0) throw new Error('member-ops: an account is required');
};

export function memberOps(nova: MemberClient, signer: PendingResolver): MemberOps {
  return {
    async isMember(groupId, account) {
      need(groupId, account);
      const v = await nova.isAuthorized(groupId, account);
      if (typeof v !== 'boolean') throw new Error('member-ops: is_authorized did not return a boolean');
      return v;
    },
    async add(groupId, account) {
      need(groupId, account);
      await signer.resolvePending();
      await nova.addGroupMember(groupId, account);
    },
    async revoke(groupId, account) {
      need(groupId, account);
      await signer.resolvePending();
      await nova.revokeGroupMember(groupId, account);
    },
  };
}