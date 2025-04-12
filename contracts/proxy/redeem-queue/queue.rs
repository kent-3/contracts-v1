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
        let mut visited_indices = std::collections::HashSet::new();

        for _ in 0..limit {
            // If we've already visited this index, we're in a cycle
            if !visited_indices.insert(current) {
                break;
            }

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
    /// or appends to an existing entry if the user owns the tail
    pub fn enqueue(&mut self, address: &str, amount: Uint128) -> Result<u64> {
        // Get the current tail
        let tail_index = self.storage.queue_tail(self.vault);

        // Check if the tail entry belongs to this user
        if let Some(tail_idx) = tail_index {
            // Get the current queue entry count
            let count = self.entry_count();

            // If count is 0, we know the queue is empty despite having a tail_idx
            // This means all entries have been processed
            if count > 0 {
                if let Some(tail_address) = self.storage.index_address(self.vault, tail_idx) {
                    if tail_address == address {
                        // User owns the tail entry, append to it instead of creating a new one
                        if let Some(current_amount) =
                            self.storage.index_amount(self.vault, tail_idx)
                        {
                            let new_amount = Uint128::new(current_amount) + amount;
                            self.storage
                                .set_index_amount(self.vault, tail_idx, new_amount.u128());
                            return Ok(tail_idx);
                        }
                    }
                }
            }
        }

        // If we got here, create a new entry

        // Get the next available index
        let index = match tail_index {
            Some(tail) => {
                // If tail exists, find next available index or increment
                match self.storage.queue_index_next(self.vault, tail) {
                    Some(tail_next) => tail_next,
                    None => tail + 1,
                }
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
    /// to disconnect the entry from the queue and removes the entry's links from storage.
    ///
    /// After removal, a query for this entry will return None for both address and amount.
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
                // Single element in queue - keep the head/tail pointing to the last processed index.
                // This lets us know what the last index was for determining the next one
                // Even though the entry is removed, the pointers remain
            }
            (None, Some(next_idx)) => {
                // Head of queue
                self.storage.set_queue_head(self.vault, next_idx);
                // Remove prev link from new head (to ensure it's None, not 0)
                self.storage.remove_queue_index_prev(self.vault, next_idx);
            }
            (Some(prev_idx), None) => {
                // Tail of queue
                self.storage.set_queue_tail(self.vault, prev_idx);
                // Remove next link from new tail (to ensure it's None, not 0)
                self.storage.remove_queue_index_next(self.vault, prev_idx);
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

        // Remove the entry's links from the main queue
        self.storage.remove_queue_index_next(self.vault, index);
        self.storage.remove_queue_index_prev(self.vault, index);

        // Update user's entry linkage
        let user_prev = self.storage.user_index_prev(&address, index);
        let user_next = self.storage.user_index_next(&address, index);

        match (user_prev, user_next) {
            (None, None) => {
                // Single element for user
                self.storage.remove_user_head(&address);
                self.storage.remove_user_tail(&address);
            }
            (None, Some(next_idx)) => {
                // Head of user's entries
                self.storage.set_user_head(&address, next_idx);
                // Remove prev link from new head
                self.storage.remove_user_index_prev(&address, next_idx);
            }
            (Some(prev_idx), None) => {
                // Tail of user's entries
                self.storage.set_user_tail(&address, prev_idx);
                // Remove next link from new tail
                self.storage.remove_user_index_next(&address, prev_idx);
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

        // Remove the entry's links from user's queue
        self.storage.remove_user_index_next(&address, index);
        self.storage.remove_user_index_prev(&address, index);

        // Remove the entry's data
        self.storage.remove_index_address(self.vault, index);
        self.storage.remove_index_amount(self.vault, index);

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
        // NOTE: Using 1 instead of 0 to accommodate precision errors
        while remaining > Uint128::one() {
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
        let mut visited_indices = std::collections::HashSet::new();

        for _ in 0..limit {
            // If we've already visited this index, we're in a cycle
            if !visited_indices.insert(current) {
                break;
            }

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

#[cfg(test)]
mod tests {
    use anyhow::Result;
    use cosmwasm_std::{testing::MockStorage, Uint128};

    use crate::queue::{ReadOnlyRedemptionQueue, RedemptionQueue};
    use crate::state::StorageExt as _;

    #[test]
    fn test_new_queue_is_empty() {
        let mut storage = MockStorage::new();
        let queue = RedemptionQueue::new(&mut storage, "test_vault");

        assert_eq!(queue.entry_count(), 0);
    }

    #[test]
    fn test_enqueue_adds_entry() -> Result<()> {
        let mut storage = MockStorage::new();
        let mut queue = RedemptionQueue::new(&mut storage, "test_vault");
        let address = "user1".to_string();

        let index = queue.enqueue(&address, Uint128::new(100))?;

        assert_eq!(index, 0);
        assert_eq!(queue.entry_count(), 1);

        let entry = queue.get_entry(0).unwrap();
        assert_eq!(entry.index, 0);
        assert_eq!(entry.address, address);
        assert_eq!(entry.amount, Uint128::new(100));

        Ok(())
    }

    #[test]
    fn test_enqueue_multiple_entries() -> Result<()> {
        let mut storage = MockStorage::new();
        let mut queue = RedemptionQueue::new(&mut storage, "test_vault");

        let index1 = queue.enqueue("user1", Uint128::new(100))?;
        let index2 = queue.enqueue("user2", Uint128::new(200))?;
        let index3 = queue.enqueue("user3", Uint128::new(300))?;

        assert_eq!(index1, 0);
        assert_eq!(index2, 1);
        assert_eq!(index3, 2);
        assert_eq!(queue.entry_count(), 3);

        // Check head and tail are set correctly
        assert_eq!(storage.queue_head("test_vault").unwrap(), 0);
        assert_eq!(storage.queue_tail("test_vault").unwrap(), 2);

        // Check entries are linked correctly
        assert_eq!(storage.queue_index_next("test_vault", 0).unwrap(), 1);
        assert_eq!(storage.queue_index_next("test_vault", 1).unwrap(), 2);
        assert!(storage.queue_index_next("test_vault", 2).is_none());

        assert!(storage.queue_index_prev("test_vault", 0).is_none());
        assert_eq!(storage.queue_index_prev("test_vault", 1).unwrap(), 0);
        assert_eq!(storage.queue_index_prev("test_vault", 2).unwrap(), 1);

        Ok(())
    }

    #[test]
    fn test_enqueue_appends_to_user_tail() -> Result<()> {
        let mut storage = MockStorage::new();
        let mut queue = RedemptionQueue::new(&mut storage, "test_vault");

        // Add entries from different users
        queue.enqueue("user1", Uint128::new(100))?;
        queue.enqueue("user2", Uint128::new(200))?;

        // Add another entry from user1
        let index = queue.enqueue("user1", Uint128::new(300))?;
        assert_eq!(index, 2);

        // Check user linkage
        assert_eq!(storage.user_head("user1").unwrap(), 0);
        assert_eq!(storage.user_tail("user1").unwrap(), 2);
        assert_eq!(storage.user_index_next("user1", 0).unwrap(), 2);
        assert_eq!(storage.user_index_prev("user1", 2).unwrap(), 0);

        // Check the user entries
        let ro_queue = ReadOnlyRedemptionQueue::new(&storage, "test_vault");
        let entries = ro_queue.get_user_entries("user1", None, None);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].amount, Uint128::new(100));
        assert_eq!(entries[1].amount, Uint128::new(300));

        Ok(())
    }

    #[test]
    fn test_enqueue_to_existing_tail() -> Result<()> {
        let mut storage = MockStorage::new();
        let mut queue = RedemptionQueue::new(&mut storage, "test_vault");

        // Add an entry
        queue.enqueue("user1", Uint128::new(100))?;

        // Add another entry from the same user, which should append to the tail
        queue.enqueue("user1", Uint128::new(200))?;

        assert_eq!(queue.entry_count(), 1);

        // Check the entry was updated
        let entry = queue.get_entry(0).unwrap();
        assert_eq!(entry.amount, Uint128::new(300));

        Ok(())
    }

    #[test]
    fn test_remove_entry_from_middle() -> Result<()> {
        let mut storage = MockStorage::new();
        let mut queue = RedemptionQueue::new(&mut storage, "test_vault");

        // Add three entries
        queue.enqueue("user1", Uint128::new(100))?;
        queue.enqueue("user2", Uint128::new(200))?;
        queue.enqueue("user3", Uint128::new(300))?;

        // Remove the middle entry
        let (address, amount) = queue.remove_entry(1)?;

        assert_eq!(address, "user2");
        assert_eq!(amount, Uint128::new(200));
        assert_eq!(queue.entry_count(), 2);

        // Check linkage is updated
        assert_eq!(storage.queue_index_next("test_vault", 0).unwrap(), 2);
        assert_eq!(storage.queue_index_prev("test_vault", 2).unwrap(), 0);

        Ok(())
    }

    #[test]
    fn test_remove_entry_from_head() -> Result<()> {
        let mut storage = MockStorage::new();
        let mut queue = RedemptionQueue::new(&mut storage, "test_vault");

        // Add two entries
        queue.enqueue("user1", Uint128::new(100))?;
        queue.enqueue("user2", Uint128::new(200))?;

        // Remove the head
        let (address, amount) = queue.remove_entry(0)?;

        assert_eq!(address, "user1");
        assert_eq!(amount, Uint128::new(100));
        assert_eq!(queue.entry_count(), 1);

        // Check head is updated
        assert_eq!(storage.queue_head("test_vault").unwrap(), 1);
        assert!(storage.queue_index_prev("test_vault", 1).is_none());

        Ok(())
    }

    #[test]
    fn test_remove_entry_from_tail() -> Result<()> {
        let mut storage = MockStorage::new();
        let mut queue = RedemptionQueue::new(&mut storage, "test_vault");

        // Add two entries
        queue.enqueue("user1", Uint128::new(100))?;
        queue.enqueue("user2", Uint128::new(200))?;

        // Remove the tail
        let (address, amount) = queue.remove_entry(1)?;

        assert_eq!(address, "user2");
        assert_eq!(amount, Uint128::new(200));
        assert_eq!(queue.entry_count(), 1);

        // Check tail is updated
        assert_eq!(storage.queue_tail("test_vault").unwrap(), 0);
        assert!(storage.queue_index_next("test_vault", 0).is_none());

        Ok(())
    }

    #[test]
    fn test_remove_only_entry() -> Result<()> {
        let mut storage = MockStorage::new();
        let mut queue = RedemptionQueue::new(&mut storage, "test_vault");

        // Add one entry
        queue.enqueue("user1", Uint128::new(100))?;

        // Remove it
        let (address, amount) = queue.remove_entry(0)?;

        assert_eq!(address, "user1");
        assert_eq!(amount, Uint128::new(100));
        assert_eq!(queue.entry_count(), 0);

        // Head and tail should still point to the last processed index (0),
        // even though the entry has been removed
        assert_eq!(storage.queue_head("test_vault").unwrap(), 0);
        assert_eq!(storage.queue_tail("test_vault").unwrap(), 0);

        Ok(())
    }

    #[test]
    fn test_process_head_empty_queue() -> Result<()> {
        let mut storage = MockStorage::new();
        let mut queue = RedemptionQueue::new(&mut storage, "test_vault");

        let (processed, used) = queue.process_head(Uint128::new(1000))?;

        assert!(processed.is_empty());
        assert_eq!(used, Uint128::zero());

        Ok(())
    }

    #[test]
    fn test_process_head_partial() -> Result<()> {
        let mut storage = MockStorage::new();
        let mut queue = RedemptionQueue::new(&mut storage, "test_vault");

        // Add an entry with more than available
        queue.enqueue("user1", Uint128::new(1000))?;

        // Process with less than required
        let (processed, used) = queue.process_head(Uint128::new(600))?;

        assert_eq!(processed.len(), 1);
        assert_eq!(processed[0].0, "user1");
        assert_eq!(processed[0].1, Uint128::new(600));
        assert_eq!(used, Uint128::new(600));

        // Entry should still be there with reduced amount
        assert_eq!(queue.entry_count(), 1);
        let entry = queue.get_entry(0).unwrap();
        assert_eq!(entry.amount, Uint128::new(400));

        Ok(())
    }

    #[test]
    fn test_process_head_complete() -> Result<()> {
        let mut storage = MockStorage::new();
        let mut queue = RedemptionQueue::new(&mut storage, "test_vault");

        // Add an entry
        queue.enqueue("user1", Uint128::new(500))?;

        // Process with enough to cover it
        let (processed, used) = queue.process_head(Uint128::new(1000))?;

        assert_eq!(processed.len(), 1);
        assert_eq!(processed[0].0, "user1");
        assert_eq!(processed[0].1, Uint128::new(500));
        assert_eq!(used, Uint128::new(500));

        // Queue should be empty
        assert_eq!(queue.entry_count(), 0);

        Ok(())
    }

    #[test]
    fn test_process_head_multiple() -> Result<()> {
        let mut storage = MockStorage::new();
        let mut queue = RedemptionQueue::new(&mut storage, "test_vault");

        // Add multiple entries
        queue.enqueue("user1", Uint128::new(300))?;
        queue.enqueue("user2", Uint128::new(400))?;
        queue.enqueue("user3", Uint128::new(500))?;

        // Process with enough for first two entries plus partial of third
        let (processed, used) = queue.process_head(Uint128::new(900))?;

        assert_eq!(processed.len(), 3);
        assert_eq!(processed[0].0, "user1");
        assert_eq!(processed[0].1, Uint128::new(300));
        assert_eq!(processed[1].0, "user2");
        assert_eq!(processed[1].1, Uint128::new(400));
        assert_eq!(processed[2].0, "user3");
        assert_eq!(processed[2].1, Uint128::new(200));
        assert_eq!(used, Uint128::new(900));

        // Check remaining entry
        assert_eq!(queue.entry_count(), 1);
        let entry = queue.get_entry(2).unwrap();
        assert_eq!(entry.amount, Uint128::new(300));

        Ok(())
    }

    #[test]
    fn test_cancel_user_entries() -> Result<()> {
        let mut storage = MockStorage::new();
        let mut queue = RedemptionQueue::new(&mut storage, "test_vault");

        // Add entries from multiple users
        queue.enqueue("user1", Uint128::new(100))?;
        queue.enqueue("user2", Uint128::new(200))?;
        queue.enqueue("user1", Uint128::new(300))?;
        queue.enqueue("user3", Uint128::new(400))?;
        queue.enqueue("user1", Uint128::new(500))?;

        // Cancel all entries for user1
        let cancelled = queue.cancel_user_entries("user1")?;

        assert_eq!(cancelled.len(), 3);
        let total: u128 = cancelled.iter().map(|(_, amount)| amount.u128()).sum();
        assert_eq!(total, 900);

        // Check remaining entries
        assert_eq!(queue.entry_count(), 2);

        // Check user linkage is cleared
        assert!(storage.user_head("user1").is_none());
        assert!(storage.user_tail("user1").is_none());

        // Verify only user2 and user3 entries remain
        let ro_queue = ReadOnlyRedemptionQueue::new(&storage, "test_vault");
        let entries = ro_queue.get_all_entries(None, None);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].address, "user2");
        assert_eq!(entries[1].address, "user3");

        Ok(())
    }

    #[test]
    fn test_get_entry_position() -> Result<()> {
        let mut storage = MockStorage::new();
        let mut queue = RedemptionQueue::new(&mut storage, "test_vault");

        // Add entries
        queue.enqueue("user1", Uint128::new(100))?;
        queue.enqueue("user2", Uint128::new(200))?;
        queue.enqueue("user3", Uint128::new(300))?;

        // Check position of second entry
        let ro_queue = ReadOnlyRedemptionQueue::new(&storage, "test_vault");
        let (position, amount_in_front) = ro_queue.get_entry_position(1)?;

        assert_eq!(position, 1);
        assert_eq!(amount_in_front, Uint128::new(100));

        // Check position of third entry
        let (position, amount_in_front) = ro_queue.get_entry_position(2)?;

        assert_eq!(position, 2);
        assert_eq!(amount_in_front, Uint128::new(300));

        Ok(())
    }

    #[test]
    fn test_get_all_entries_pagination() -> Result<()> {
        let mut storage = MockStorage::new();
        let mut queue = RedemptionQueue::new(&mut storage, "test_vault");

        // Add multiple entries
        for i in 0..5 {
            queue.enqueue(
                &format!("user{}", i + 1),
                Uint128::new(100 * (i + 1) as u128),
            )?;
        }

        // Test pagination - first 2 entries
        let ro_queue = ReadOnlyRedemptionQueue::new(&storage, "test_vault");
        let entries = ro_queue.get_all_entries(None, Some(2));

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].index, 0);
        assert_eq!(entries[1].index, 1);

        // Test starting from index 2, with limit 2
        let entries = ro_queue.get_all_entries(Some(2), Some(2));

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].index, 2);
        assert_eq!(entries[1].index, 3);

        Ok(())
    }

    #[test]
    fn test_get_user_entries_pagination() -> Result<()> {
        let mut storage = MockStorage::new();
        let mut queue = RedemptionQueue::new(&mut storage, "test_vault");

        // Add alternating user entries
        queue.enqueue("user1", Uint128::new(100))?;
        queue.enqueue("user2", Uint128::new(200))?;
        queue.enqueue("user1", Uint128::new(300))?;
        queue.enqueue("user2", Uint128::new(400))?;
        queue.enqueue("user1", Uint128::new(500))?;

        // Check all user1 entries
        let ro_queue = ReadOnlyRedemptionQueue::new(&storage, "test_vault");
        let entries = ro_queue.get_user_entries("user1", None, None);

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].amount, Uint128::new(100));
        assert_eq!(entries[1].amount, Uint128::new(300));
        assert_eq!(entries[2].amount, Uint128::new(500));

        // Test pagination - just the first user1 entry
        let entries = ro_queue.get_user_entries("user1", None, Some(1));

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].amount, Uint128::new(100));

        // Test starting from second user1 entry
        let user1_head = storage.user_head("user1").unwrap();
        let second_entry = storage.user_index_next("user1", user1_head).unwrap();

        let entries = ro_queue.get_user_entries("user1", Some(second_entry), None);

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].amount, Uint128::new(300));
        assert_eq!(entries[1].amount, Uint128::new(500));

        Ok(())
    }

    #[test]
    fn test_cycle_detection() -> Result<()> {
        let mut storage = MockStorage::new();

        // Manually create a cycle in user entries
        storage.set_user_head("user1", 1);
        storage.set_user_tail("user1", 3);

        storage.set_index_address("test_vault", 1, "user1");
        storage.set_index_amount("test_vault", 1, 100);

        storage.set_index_address("test_vault", 2, "user1");
        storage.set_index_amount("test_vault", 2, 200);

        storage.set_index_address("test_vault", 3, "user1");
        storage.set_index_amount("test_vault", 3, 300);

        // Create a cycle: 1->2->3->1
        storage.set_user_index_next("user1", 1, 2);
        storage.set_user_index_next("user1", 2, 3);
        storage.set_user_index_next("user1", 3, 1); // This creates the cycle

        storage.set_user_index_prev("user1", 2, 1);
        storage.set_user_index_prev("user1", 3, 2);
        storage.set_user_index_prev("user1", 1, 3); // Complete the cycle

        // Set entry count
        storage.set_entry_count("test_vault", 3);

        // The read-only queue should detect and handle the cycle
        let ro_queue = ReadOnlyRedemptionQueue::new(&storage, "test_vault");
        let entries = ro_queue.get_user_entries("user1", None, None);

        // Instead of infinite loop, should return 3 entries
        assert_eq!(entries.len(), 3);

        Ok(())
    }

    #[test]
    fn test_no_index_reuse_after_processing() -> Result<()> {
        let mut storage = MockStorage::new();
        let mut queue = RedemptionQueue::new(&mut storage, "test_vault");

        // First, enqueue an entry for user1
        let index1 = queue.enqueue("user1", Uint128::new(100))?;
        assert_eq!(index1, 0);
        assert_eq!(queue.entry_count(), 1);

        // Process this entry (simulating immediate processing)
        let available_amount = Uint128::new(100);
        let (processed, used_amount) = queue.process_head(available_amount)?;

        // Verify the entry was processed
        assert_eq!(processed.len(), 1);
        assert_eq!(processed[0].0, "user1");
        assert_eq!(processed[0].1, Uint128::new(100));
        assert_eq!(used_amount, Uint128::new(100));

        // Verify queue is now empty
        assert_eq!(queue.entry_count(), 0);

        // Now, enqueue another entry for user2
        let index2 = queue.enqueue("user2", Uint128::new(200))?;

        // The key test: index2 should NOT be 0 (reusing index1)
        // It should be a new index (1)
        assert_eq!(
            index2, 1,
            "Second entry should use index 1, not reuse index 0"
        );

        // Verify the entry is properly in the queue
        assert_eq!(queue.entry_count(), 1);
        let entry = queue.get_entry(index2).unwrap();
        assert_eq!(entry.address, "user2");
        assert_eq!(entry.amount, Uint128::new(200));

        // Now process this entry too
        let available_amount = Uint128::new(200);
        let (processed, _used_amount) = queue.process_head(available_amount)?;

        // Verify it was processed
        assert_eq!(processed.len(), 1);
        assert_eq!(processed[0].0, "user2");
        assert_eq!(processed[0].1, Uint128::new(200));

        // Queue is empty again
        assert_eq!(queue.entry_count(), 0);

        // Enqueue a third entry for user3
        let index3 = queue.enqueue("user3", Uint128::new(300))?;

        // This should be index 2, not reusing 0 or 1
        assert_eq!(
            index3, 2,
            "Third entry should use index 2, not reuse index 0 or 1"
        );

        // Verify the entry
        assert_eq!(queue.entry_count(), 1);
        let entry = queue.get_entry(index3).unwrap();
        assert_eq!(entry.address, "user3");
        assert_eq!(entry.amount, Uint128::new(300));

        Ok(())
    }
}
