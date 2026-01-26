use crate::models::{User, Identifiable};
use crate::Repository;

pub struct UserService {
    users: Vec<User>,
}

impl UserService {
    pub fn new() -> Self {
        Self { users: Vec::new() }
    }

    pub fn create(&self, name: &str) -> User {
        User::new(name)
    }

    pub fn find_by_name(&self, name: &str) -> Option<&User> {
        self.users.iter().find(|u| u.name == name)
    }
}

impl Default for UserService {
    fn default() -> Self {
        Self::new()
    }
}

impl Repository<User> for UserService {
    fn save(&self, _item: &User) -> Result<(), String> {
        Ok(())
    }

    fn find(&self, id: u64) -> Option<User> {
        self.users.iter().find(|u| u.id() == id).cloned()
    }
}
