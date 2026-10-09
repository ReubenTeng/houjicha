# Group Buying

Users join group buys for items from a merchant, with one shared collection point per group buy.

## Language

**Merchant**:
The seller from whose catalog a group buy's items are selected.
_Avoid_: Store

Compatibility with the earlier adapter: `merchantId` is our internal registry identity and resolves to `ReapWrapper`'s `storeId`. It is not an upstream Reap merchant UUID, and a merchant display name is not sufficient proof of identity. An ambiguous or unverified mapping blocks purchase. Use “merchant” in the domain while retaining the existing adapter field name.

**Group buy**:
A merchant-level collective purchase with one shared collection point and collection window. Participants can add different items from that merchant, including items not already requested by other participants.

Compatibility with the earlier adapter: orchestration resolves `groupBuyId` to the adapter's `groupOrderId` and retains that mapping durably. Renaming a field must not create a second financial operation for the same buy.

**Participant**:
A user who has joined a group buy.

**Organizer**:
The user who started a group buy and is responsible for receiving and distributing its order.

**Collection point**:
The shared location where participants collect their items for a group buy.

**Collection window**:
The agreed time interval during which participants can collect their items from the organizer.

**Joining deadline**:
The time when a group buy stops accepting new participants. It is separate from the collection window.
