use anyhow::{bail, Result};
use cosmwasm_std::{Storage, Uint128};

use crate::state::StorageExt as _;

/// Entry in the redemption queue
pub struct Entry {
    pub index: u64,
    pub address: String,
    pub amount: Uint128,
}

/// Represents a redemption queue for a specific vault
pub struct RedemptionQueue<'a> {
    pub vault: &'a str,
    pub storage: &'a mut dyn Storage,
}

impl<'a> RedemptionQueue<'a> {
    /// Create a new redemption queue for the specified vault
    pub fn new(storage: &'a mut dyn Storage, vault: &'a str) -> Self {
        Self { vault, storage }
    }

    /// Returns the total number of entries in the queue
    pub fn entry_count(&self) -> u64 {
        self.storage.entry_count(self.vault).unwrap_or(0)
    }

    /// Returns the entry at the specified index, if it exists
    pub fn get_entry(&self, index: u64) -> Option<Entry> {
        let address = self.storage.index_address(self.vault, index)?;
        let amount = self.storage.index_amount(self.vault, index)?;

        Some(Entry {
            index,
            address,
            amount: Uint128::new(amount),
        })
    }

    /// Returns all entries in the queue, starting from the head
    pub fn get_all_entries(&self, start_index: Option<u64>, limit: Option<u64>) -> Vec<Entry> {
        let count = self.entry_count();
        if count == 0 {
            return vec![];
        }

        let start = start_index.unwrap_or_else(|| self.storage.queue_head(self.vault).unwrap_or(0));

        let limit = limit.unwrap_or(count);
        let mut entries = Vec::with_capacity(limit as usize);
        let mut current = start;

        for _ in 0..limit {
            match self.get_entry(current) {
                Some(entry) => {
                    entries.push(entry);

                    match self.storage.queue_index_next(self.vault, current) {
                        Some(next) => current = next,
                        None => break, // End of queue
                    }
                }
                None => break, // Invalid entry, end loop
            }
        }

        entries
    }

    /// Returns all entries belonging to the specified address
    pub fn get_user_entries(
        &self,
        address: &str,
        start: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<Entry> {
        let head = match self.storage.user_head(address) {
            Some(head) => head,
            None => return vec![], // No entries for this user
        };

        let start = start.unwrap_or(head);
        let limit = limit.unwrap_or(u64::MAX);
        let mut entries = Vec::new();
        let mut current = start;

        for _ in 0..limit {
            match self.get_entry(current) {
                Some(entry) if entry.address == address => {
                    entries.push(entry);

                    match self.storage.user_index_next(address, current) {
                        Some(next) => current = next,
                        None => break, // End of user's entries
                    }
                }
                _ => break, // Invalid entry or not owned by user, end loop
            }
        }

        entries
    }

    /// Returns the position of an entry in the queue and the total amount ahead of it
    pub fn get_entry_position(&self, index: u64) -> Result<(u64, Uint128)> {
        let head = self.storage.queue_head(self.vault).unwrap_or(0);
        let mut current = head;
        let mut position = 0;
        let mut amount_ahead = Uint128::zero();

        loop {
            if current == index {
                return Ok((position, amount_ahead));
            }

            match self.storage.index_amount(self.vault, current) {
                Some(amount) => {
                    amount_ahead += Uint128::new(amount);
                }
                None => bail!(
                    "Invalid queue structure: missing amount for index {}",
                    current
                ),
            }

            match self.storage.queue_index_next(self.vault, current) {
                Some(next) => {
                    current = next;
                    position += 1;
                }
                None => bail!("Entry with index {} not found in queue", index),
            }
        }
    }

    /// Adds a new entry to the queue for the specified address and amount
    pub fn enqueue(&mut self, address: &str, amount: Uint128) -> Result<u64> {
        // Get the next available index
        let index = match self.storage.queue_tail(self.vault) {
            Some(tail) => {
                // If tail exists, find next available index or increment
                let tail_next = match self.storage.queue_index_next(self.vault, tail) {
                    Some(next) => next,
                    None => tail + 1,
                };
                tail_next
            }
            None => 0, // First entry
        };

        // Store entry data
        self.storage.set_index_address(self.vault, index, address);
        self.storage
            .set_index_amount(self.vault, index, amount.u128());

        let count = self.entry_count();

        if count == 0 {
            // First entry in the queue
            self.storage.set_queue_head(self.vault, index);
            self.storage.set_queue_tail(self.vault, index);
        } else {
            // Append to tail - we know the tail exists since count > 0
            // This is safe because we've already checked count > 0, which means
            // queue_tail must return Some value
            let tail = match self.storage.queue_tail(self.vault) {
                Some(t) => t,
                None => bail!("Queue tail not found but count is {}", count),
            };

            // Link tail -> new entry
            self.storage.set_queue_index_next(self.vault, tail, index);

            // Link new entry -> tail
            self.storage.set_queue_index_prev(self.vault, index, tail);

            // Update tail
            self.storage.set_queue_tail(self.vault, index);
        }

        // Update user's entry linkage
        let user_has_entries = self.storage.user_head(address).is_some();

        if !user_has_entries {
            // First entry for this user
            self.storage.set_user_head(address, index);
            self.storage.set_user_tail(address, index);
        } else {
            // Append to user's tail
            let user_tail = match self.storage.user_tail(address) {
                Some(t) => t,
                None => bail!("User tail not found but user_head exists"),
            };

            // Link user tail -> new entry
            self.storage.set_user_index_next(address, user_tail, index);

            // Link new entry -> user tail
            self.storage.set_user_index_prev(address, index, user_tail);

            // Update user's tail
            self.storage.set_user_tail(address, index);
        }

        // Update entry count
        self.storage.set_entry_count(self.vault, count + 1);

        Ok(index)
    }

    /// Removes an entry from the queue by its index and returns the address and amount.
    ///
    /// This function updates the queue links (both main queue and user-specific links)
    /// to disconnect the entry from the queue. The entry's underlying storage data is
    /// not deleted to minimize gas costs, but it becomes inaccessible through normal
    /// queue operations.
    ///
    /// WARN: Always check if the queue is empty before calling this function.
    /// It's possible to call this function twice with the same index: `address` and `amount`
    /// will still exist, but now `count == 0` and the function will bail.
    pub fn remove_entry(&mut self, index: u64) -> Result<(String, Uint128)> {
        // Get entry data
        let address = match self.storage.index_address(self.vault, index) {
            Some(addr) => addr,
            None => bail!("Entry with index {} does not exist", index),
        };

        let amount = match self.storage.index_amount(self.vault, index) {
            Some(amt) => Uint128::new(amt),
            None => bail!("Entry with index {} does not have an amount", index),
        };

        let count = self.entry_count();
        if count == 0 {
            bail!("Queue is empty");
        }

        // Update main queue linkage
        let prev = self.storage.queue_index_prev(self.vault, index);
        let next = self.storage.queue_index_next(self.vault, index);

        match (prev, next) {
            (None, None) => {
                // Single element in queue
                self.storage.set_queue_head(self.vault, 0);
                self.storage.set_queue_tail(self.vault, 0);
            }
            (None, Some(next_idx)) => {
                // Head of queue
                self.storage.set_queue_head(self.vault, next_idx);
                // Remove prev from next
                self.storage.set_queue_index_prev(self.vault, next_idx, 0);
            }
            (Some(prev_idx), None) => {
                // Tail of queue
                self.storage.set_queue_tail(self.vault, prev_idx);
                // Remove next from prev
                self.storage.set_queue_index_next(self.vault, prev_idx, 0);
            }
            (Some(prev_idx), Some(next_idx)) => {
                // Middle of queue
                // Link prev -> next
                self.storage
                    .set_queue_index_next(self.vault, prev_idx, next_idx);
                // Link next -> prev
                self.storage
                    .set_queue_index_prev(self.vault, next_idx, prev_idx);
            }
        }

        // Update user's entry linkage
        let user_prev = self.storage.user_index_prev(&address, index);
        let user_next = self.storage.user_index_next(&address, index);

        match (user_prev, user_next) {
            (None, None) => {
                // Single element for user
                self.storage.set_user_head(&address, 0);
                self.storage.set_user_tail(&address, 0);
            }
            (None, Some(next_idx)) => {
                // Head of user's entries
                self.storage.set_user_head(&address, next_idx);
                // Remove prev from next
                self.storage.set_user_index_prev(&address, next_idx, 0);
            }
            (Some(prev_idx), None) => {
                // Tail of user's entries
                self.storage.set_user_tail(&address, prev_idx);
                // Remove next from prev
                self.storage.set_user_index_next(&address, prev_idx, 0);
            }
            (Some(prev_idx), Some(next_idx)) => {
                // Middle of user's entries
                // Link prev -> next
                self.storage
                    .set_user_index_next(&address, prev_idx, next_idx);
                // Link next -> prev
                self.storage
                    .set_user_index_prev(&address, next_idx, prev_idx);
            }
        }

        // Clean up entry data
        // Note: We don't completely remove data to allow for history queries

        // Update entry count
        self.storage.set_entry_count(self.vault, count - 1);

        Ok((address, amount))
    }

    /// Process the head of the queue with available redemption amount
    pub fn process_head(
        &mut self,
        available_amount: Uint128,
    ) -> Result<(Vec<(String, Uint128)>, Uint128)> {
        let mut remaining = available_amount;
        let mut processed = Vec::new();

        // Process entries until we run out of funds or queue is empty
        while remaining > Uint128::zero() {
            if self.entry_count() == 0 {
                break; // Empty queue
            }

            match self.storage.queue_head(self.vault) {
                Some(head) => {
                    match self.get_entry(head) {
                        Some(entry) => {
                            if entry.amount <= remaining {
                                // Process entire entry
                                let (address, amount) = self.remove_entry(head)?;
                                remaining -= amount;
                                processed.push((address, amount));
                            } else {
                                // Process partial entry
                                let address = entry.address;
                                let amount = remaining;

                                // Update entry amount
                                let new_amount = entry.amount - remaining;
                                self.storage
                                    .set_index_amount(self.vault, head, new_amount.u128());

                                remaining = Uint128::zero();
                                processed.push((address, amount));
                                break;
                            }
                        }
                        None => break, // Entry not found for head index
                    }
                }
                None => break, // Empty or uninitialized queue
            }
        }

        let used_amount = available_amount - remaining;
        Ok((processed, used_amount))
    }

    /// Cancel all entries for a specific user
    pub fn cancel_user_entries(&mut self, address: &str) -> Result<Vec<(u64, Uint128)>> {
        let mut cancelled = Vec::new();

        while let Some(head) = self.storage.user_head(address) {
            match self.remove_entry(head) {
                Ok((_, amount)) => {
                    cancelled.push((head, amount));
                }
                Err(_) => {
                    // Skip invalid entries
                    break;
                }
            }
        }

        Ok(cancelled)
    }
}

/// Read-only version of RedemptionQueue for query operations
pub struct ReadOnlyRedemptionQueue<'a> {
    pub vault: &'a str,
    pub storage: &'a dyn Storage,
}

impl<'a> ReadOnlyRedemptionQueue<'a> {
    /// Create a new read-only redemption queue for the specified vault
    pub fn new(storage: &'a dyn Storage, vault: &'a str) -> Self {
        Self { vault, storage }
    }

    /// Returns the total number of entries in the queue
    pub fn entry_count(&self) -> u64 {
        self.storage.entry_count(self.vault).unwrap_or(0)
    }

    /// Returns the entry at the specified index, if it exists
    pub fn get_entry(&self, index: u64) -> Option<Entry> {
        let address = self.storage.index_address(self.vault, index)?;
        let amount = self.storage.index_amount(self.vault, index)?;

        Some(Entry {
            index,
            address,
            amount: Uint128::new(amount),
        })
    }

    /// Returns all entries in the queue, starting from the head
    pub fn get_all_entries(&self, start_index: Option<u64>, limit: Option<u64>) -> Vec<Entry> {
        let count = self.entry_count();
        if count == 0 {
            return vec![];
        }

        let start = start_index.unwrap_or_else(|| self.storage.queue_head(self.vault).unwrap_or(0));

        let limit = limit.unwrap_or(count);
        let mut entries = Vec::with_capacity(limit as usize);
        let mut current = start;

        for _ in 0..limit {
            match self.get_entry(current) {
                Some(entry) => {
                    entries.push(entry);

                    match self.storage.queue_index_next(self.vault, current) {
                        Some(next) => current = next,
                        None => break, // End of queue
                    }
                }
                None => break, // Invalid entry, end loop
            }
        }

        entries
    }

    /// Returns all entries belonging to the specified address
    pub fn get_user_entries(
        &self,
        address: &str,
        start: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<Entry> {
        let head = match self.storage.user_head(address) {
            Some(head) => head,
            None => return vec![], // No entries for this user
        };

        let start = start.unwrap_or(head);
        let limit = limit.unwrap_or(u64::MAX);
        let mut entries = Vec::new();
        let mut current = start;

        for _ in 0..limit {
            match self.get_entry(current) {
                Some(entry) if entry.address == address => {
                    entries.push(entry);

                    match self.storage.user_index_next(address, current) {
                        Some(next) => current = next,
                        None => break, // End of user's entries
                    }
                }
                _ => break, // Invalid entry or not owned by user, end loop
            }
        }

        entries
    }

    /// Returns the position of an entry in the queue and the total amount ahead of it
    pub fn get_entry_position(&self, index: u64) -> Result<(u64, Uint128)> {
        let head = self.storage.queue_head(self.vault).unwrap_or(0);
        let mut current = head;
        let mut position = 0;
        let mut amount_ahead = Uint128::zero();

        loop {
            if current == index {
                return Ok((position, amount_ahead));
            }

            match self.storage.index_amount(self.vault, current) {
                Some(amount) => {
                    amount_ahead += Uint128::new(amount);
                }
                None => bail!(
                    "Invalid queue structure: missing amount for index {}",
                    current
                ),
            }

            match self.storage.queue_index_next(self.vault, current) {
                Some(next) => {
                    current = next;
                    position += 1;
                }
                None => bail!("Entry with index {} not found in queue", index),
            }
        }
    }
}
