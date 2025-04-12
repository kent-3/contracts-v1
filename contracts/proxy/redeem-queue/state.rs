use cosmwasm_std::Storage;

use amulet_cw::StorageExt as _;

#[rustfmt::skip]
mod key {
    use amulet_cw::MapKey;

    macro_rules! key {
        ($k:literal) => {
            concat!("redemption_queue::", $k)
        };
    }

    macro_rules! map_key {
        ($k:literal) => {
            MapKey::new(key!($k))
        };
    }

    pub const HUB              : &str   = key!("hub");
    pub const ENTRY_COUNT      : MapKey = map_key!("entry_count");
    pub const QUEUE_HEAD_INDEX : MapKey = map_key!("queue_head_index");
    pub const QUEUE_TAIL_INDEX : MapKey = map_key!("queue_tail_index");
    pub const QUEUE_INDEX_NEXT : MapKey = map_key!("queue_index_next");
    pub const QUEUE_INDEX_PREV : MapKey = map_key!("queue_index_prev");
    pub const USER_HEAD_INDEX  : MapKey = map_key!("user_head_index");
    pub const USER_TAIL_INDEX  : MapKey = map_key!("user_tail_index");
    pub const USER_INDEX_NEXT  : MapKey = map_key!("user_index_next");
    pub const USER_INDEX_PREV  : MapKey = map_key!("user_index_prev");
    pub const INDEX_ADDRESS    : MapKey = map_key!("index_address");
    pub const INDEX_AMOUNT     : MapKey = map_key!("index_amount");
}

pub trait StorageExt: Storage {
    fn set_hub(&mut self, address: &str) {
        self.set_string(key::HUB, address)
    }

    fn hub(&self) -> String {
        self.string_at(key::HUB)
            .expect("always: set during initialisation")
    }

    fn queue_head(&self, vault: &str) -> Option<u64> {
        self.u64_at(key::QUEUE_HEAD_INDEX.with(vault))
    }

    fn set_queue_head(&mut self, vault: &str, index: u64) {
        self.set_u64(key::QUEUE_HEAD_INDEX.with(vault), index)
    }

    fn queue_tail(&self, vault: &str) -> Option<u64> {
        self.u64_at(key::QUEUE_TAIL_INDEX.with(vault))
    }

    fn set_queue_tail(&mut self, vault: &str, index: u64) {
        self.set_u64(key::QUEUE_TAIL_INDEX.with(vault), index)
    }

    fn queue_index_next(&self, vault: &str, index: u64) -> Option<u64> {
        self.u64_at(key::QUEUE_INDEX_NEXT.multi([&vault, &index]))
    }

    fn set_queue_index_next(&mut self, vault: &str, index: u64, next: u64) {
        self.set_u64(key::QUEUE_INDEX_NEXT.multi([&vault, &index]), next)
    }

    fn queue_index_prev(&self, vault: &str, index: u64) -> Option<u64> {
        self.u64_at(key::QUEUE_INDEX_PREV.multi([&vault, &index]))
    }

    fn set_queue_index_prev(&mut self, vault: &str, index: u64, prev: u64) {
        self.set_u64(key::QUEUE_INDEX_PREV.multi([&vault, &index]), prev)
    }

    fn user_head(&self, address: &str) -> Option<u64> {
        self.u64_at(key::USER_HEAD_INDEX.with(address))
    }

    fn set_user_head(&mut self, address: &str, index: u64) {
        self.set_u64(key::USER_HEAD_INDEX.with(address), index)
    }

    fn user_tail(&self, address: &str) -> Option<u64> {
        self.u64_at(key::USER_TAIL_INDEX.with(address))
    }

    fn set_user_tail(&mut self, address: &str, index: u64) {
        self.set_u64(key::USER_TAIL_INDEX.with(address), index)
    }

    fn user_index_next(&self, address: &str, index: u64) -> Option<u64> {
        self.u64_at(key::USER_INDEX_NEXT.multi([&address, &index]))
    }

    fn set_user_index_next(&mut self, address: &str, index: u64, next: u64) {
        self.set_u64(key::USER_INDEX_NEXT.multi([&address, &index]), next)
    }

    fn user_index_prev(&self, address: &str, index: u64) -> Option<u64> {
        self.u64_at(key::USER_INDEX_PREV.multi([&address, &index]))
    }

    fn set_user_index_prev(&mut self, address: &str, index: u64, prev: u64) {
        self.set_u64(key::USER_INDEX_PREV.multi([&address, &index]), prev)
    }

    fn index_address(&self, vault: &str, index: u64) -> Option<String> {
        self.string_at(key::INDEX_ADDRESS.multi([&vault, &index]))
    }

    fn set_index_address(&mut self, vault: &str, index: u64, address: &str) {
        self.set_string(key::INDEX_ADDRESS.multi([&vault, &index]), address)
    }

    fn index_amount(&self, vault: &str, index: u64) -> Option<u128> {
        self.u128_at(key::INDEX_AMOUNT.multi([&vault, &index]))
    }

    fn set_index_amount(&mut self, vault: &str, index: u64, amount: u128) {
        self.set_u128(key::INDEX_AMOUNT.multi([&vault, &index]), amount)
    }

    fn entry_count(&self, vault: &str) -> Option<u64> {
        self.u64_at(key::ENTRY_COUNT.with(vault))
    }

    fn set_entry_count(&mut self, vault: &str, count: u64) {
        self.set_u64(key::ENTRY_COUNT.with(vault), count)
    }

    fn remove_queue_index_next(&mut self, vault: &str, index: u64) {
        self.remove(key::QUEUE_INDEX_NEXT.multi([&vault, &index]).as_bytes());
    }

    fn remove_queue_index_prev(&mut self, vault: &str, index: u64) {
        self.remove(key::QUEUE_INDEX_PREV.multi([&vault, &index]).as_bytes());
    }

    fn remove_user_head(&mut self, address: &str) {
        self.remove(key::USER_HEAD_INDEX.with(address).as_bytes());
    }

    fn remove_user_tail(&mut self, address: &str) {
        self.remove(key::USER_TAIL_INDEX.with(address).as_bytes());
    }

    fn remove_user_index_next(&mut self, address: &str, index: u64) {
        self.remove(key::USER_INDEX_NEXT.multi([&address, &index]).as_bytes());
    }

    fn remove_user_index_prev(&mut self, address: &str, index: u64) {
        self.remove(key::USER_INDEX_PREV.multi([&address, &index]).as_bytes());
    }

    fn remove_index_address(&mut self, vault: &str, index: u64) {
        self.remove(key::INDEX_ADDRESS.multi([&vault, &index]).as_bytes());
    }

    fn remove_index_amount(&mut self, vault: &str, index: u64) {
        self.remove(key::INDEX_AMOUNT.multi([&vault, &index]).as_bytes());
    }
}

impl<T> StorageExt for T where T: Storage + ?Sized {}
