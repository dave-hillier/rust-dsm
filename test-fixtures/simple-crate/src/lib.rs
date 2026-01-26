pub mod models;
pub mod services;
pub mod utils;

use models::User;
use services::UserService;

pub fn create_user(name: &str) -> User {
    let service = UserService::new();
    service.create(name)
}

pub trait Repository<T> {
    fn save(&self, item: &T) -> Result<(), String>;
    fn find(&self, id: u64) -> Option<T>;
}
