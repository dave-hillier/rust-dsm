use crate::utils::generate_id;

#[derive(Debug, Clone)]
pub struct User {
    pub id: u64,
    pub name: String,
    pub email: Option<String>,
}

impl User {
    pub fn new(name: &str) -> Self {
        Self {
            id: generate_id(),
            name: name.to_string(),
            email: None,
        }
    }

    pub fn with_email(mut self, email: &str) -> Self {
        self.email = Some(email.to_string());
        self
    }
}

#[derive(Debug)]
pub enum UserRole {
    Admin,
    Member,
    Guest,
}

pub trait Identifiable {
    fn id(&self) -> u64;
}

impl Identifiable for User {
    fn id(&self) -> u64 {
        self.id
    }
}
