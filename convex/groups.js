import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

export const getGroupExpenses = query({
  args: { groupId: v.id("groups") },
  handler: async (ctx, { groupId }) => {
    const currentUser = await ctx.runQuery(internal.users.getCurrentUser);

    const group = await ctx.db.get(groupId);
    if (!group) throw new Error("Group not found");
    if (
      !group.members.some((m) => m.userId === currentUser._id) &&
      group.createdBy !== currentUser._id
    ) {
      throw new Error("You are not a member of this group");
    }

    const expenses = await ctx.db
      .query("expenses")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();

    const memberDetails = await Promise.all(
      group.members.map(async (m) => {
        const u = await ctx.db.get(m.userId);
        return { id: u._id, name: u.name, imageUrl: u.imageUrl, role: m.role };
      })
    );

    const ids = memberDetails.map((m) => m.id);
    const indexMap = new Map(ids.map((id, i) => [id, i]));

    const n = ids.length;
    const txn = Array.from({ length: n }, () => Array(n).fill(0));

    for (const exp of expenses) {
      const payerIdx = indexMap.get(exp.paidByUserId);
      for (const split of exp.splits) {
        if (split.userId === exp.paidByUserId || split.paid) continue;
        const debtorIdx = indexMap.get(split.userId);
        txn[debtorIdx][payerIdx] += split.amount;
      }
    }

    const net = txn.map((row, i) => {
      const outgoing = row.reduce((sum, val) => sum + val, 0);
      const incoming = txn.reduce((inSum, r) => inSum + r[i], 0);
      return incoming - outgoing;
    });

    const parties = net
      .map((amt, idx) => ({ amt, idx }))
      .filter(({ amt }) => amt !== 0)
      .sort((a, b) => a.amt - b.amt);

    const optimized = Array.from({ length: n }, () => Array(n).fill(0));
    let i = 0;
    let j = parties.length - 1;

    while (i < j) {
      const debtor = parties[i];
      const creditor = parties[j];
      const debtAmt = -debtor.amt;
      const credAmt = creditor.amt;
      const transfer = Math.min(debtAmt, credAmt);

      optimized[debtor.idx][creditor.idx] = transfer;
      debtor.amt += transfer;
      creditor.amt -= transfer;

      if (debtor.amt === 0) i++;
      if (creditor.amt === 0) j--;
    }

    const balances = memberDetails.map((m, idx) => ({
      ...m,
      totalBalance: net[idx],
      owes: optimized[idx]
        .map((amt, jdx) => ({ to: ids[jdx], amount: amt }))
        .filter((x) => x.amount > 0),
      owedBy: optimized
        .map((row, jdx) => ({ from: ids[jdx], amount: row[idx] }))
        .filter((x) => x.amount > 0),
    }));

    const userLookupMap = {};
    memberDetails.forEach((member) => {
      userLookupMap[member.id] = member;
    });

    return {
      group: {
        id: group._id,
        name: group.name,
        description: group.description,
      },
      members: memberDetails,
      expenses,
      balances,
      userLookupMap,
    };
  },
});

export const deleteGroup = mutation({
  args: { groupId: v.id("groups") },
  handler: async (ctx, { groupId }) => {
    const currentUser = await ctx.runQuery(internal.users.getCurrentUser);
    if (!currentUser) {
      throw new Error("Authentication required");
    }

    const group = await ctx.db.get(groupId);

    if (!group) {
      throw new Error("Group not found");
    }

    if (!group.members.some((m) => m.userId === currentUser._id)) {
      throw new Error("You are not a member of this group");
    }

    if (group.createdBy !== currentUser._id) {
      throw new Error("You are not authorized to delete this group");
    }

    const expenses = await ctx.db
      .query("expenses")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();

    await Promise.all(expenses.map((expense) => ctx.db.delete(expense._id)));

    await ctx.db.delete(groupId);

    return { success: true };
  },
});

export const getGroupsOrMembers = query({
  args: { groupId: v.optional(v.id("groups")) },
  handler: async (ctx, args) => {
    const currentUser = await ctx.runQuery(internal.users.getCurrentUser);

    const allGroups = await ctx.db.query("groups").collect();
    const userGroups = allGroups.filter((group) =>
      group.members.some((member) => member.userId === currentUser._id)
    );

    if (args.groupId) {
      const selectedGroup = userGroups.find(
        (group) => group._id === args.groupId
      );

      if (!selectedGroup) {
        throw new Error("Group not found or you're not a member");
      }
      const memberDetails = await Promise.all(
        selectedGroup.members.map(async (member) => {
          const user = await ctx.db.get(member.userId);
          if (!user) return null;

          return {
            id: user._id,
            name: user.name,
            email: user.email,
            imageUrl: user.imageUrl,
            role: member.role,
          };
        })
      );

      const validMembers = memberDetails.filter((member) => member !== null);

      return {
        selectedGroup: {
          id: selectedGroup._id,
          name: selectedGroup.name,
          description: selectedGroup.description,
          createdBy: selectedGroup.createdBy,
          members: validMembers,
        },
        groups: userGroups.map((group) => ({
          id: group._id,
          name: group.name,
          description: group.description,
          memberCount: group.members.length,
        })),
      };
    } else {
      return {
        selectedGroup: null,
        groups: userGroups.map((group) => ({
          id: group._id,
          name: group.name,
          description: group.description,
          memberCount: group.members.length,
        })),
      };
    }
  },
});
