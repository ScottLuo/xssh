package store

// Host represents an SSH host card stored in the database.
type Host struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Host       string   `json:"host"`
	Port       int      `json:"port"`
	User       string   `json:"user"`
	AuthType   string   `json:"auth_type"`
	AuthSecret string   `json:"auth_secret"`
	Shell      string   `json:"shell"`
	InitCmds   []string `json:"init_cmds"`
	Color      string   `json:"color"`
	CreatedAt  string   `json:"created_at"`
	UpdatedAt  string   `json:"updated_at"`
}
