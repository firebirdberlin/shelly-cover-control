UUID = shelly-cover-control@firebirdberlin
DIST_DIR = dist

.PHONY: all bump pack release clean

all: pack

# Get the current version directly from metadata.json
VERSION = $(shell python3 -c "import json; print(json.load(open('metadata.json'))['version'])")
ZIP_FILE = $(DIST_DIR)/$(UUID)-v$(VERSION).shell-extension.zip

# 1. Increments the integer version in metadata.json by 1
bump:
	@echo "Current version is $(VERSION)"
	@python3 -c "import json; f=open('metadata.json','r+'); d=json.load(f); d['version']=d.get('version', 0)+1; f.seek(0); json.dump(d,f,indent=2); f.truncate(); f.write('\n')"
	@echo "Version bumped to $$(python3 -c "import json; print(json.load(open('metadata.json'))['version'])")"

# 2. Packages the files and renames the zip to include the version number
pack:
	@mkdir -p $(DIST_DIR)
	@echo "Packaging extension version $(VERSION)..."
	gnome-extensions pack --extra-source=screenshot.png -o $(DIST_DIR) --force
	@mv $(DIST_DIR)/$(UUID).shell-extension.zip $(ZIP_FILE)
	@echo "Package created at $(ZIP_FILE)"

# 3. Bumps version, packages, commits metadata and the SPECIFIC versioned zip, tags, and pushes
release: bump
	$(eval NEW_VERSION := $(shell python3 -c "import json; print(json.load(open('metadata.json'))['version'])"))
	$(eval NEW_ZIP_FILE := $(DIST_DIR)/$(UUID)-v$(NEW_VERSION).shell-extension.zip)
	@$(MAKE) pack VERSION=$(NEW_VERSION) ZIP_FILE=$(NEW_ZIP_FILE)
	@echo "Staging metadata change and packaged zip file..."
	git add metadata.json $(NEW_ZIP_FILE)
	git commit -m "bump: release version $(NEW_VERSION) (includes pre-packaged zip)"
	@echo "Creating git tag v$(NEW_VERSION)..."
	git tag -a v$(NEW_VERSION) -m "Release version $(NEW_VERSION)"
	@echo "Pushing commits, zip, and tags to remote..."
	git push origin main
	git push origin v$(NEW_VERSION)

# Cleans up only uncommitted/untracked files inside the distribution directory
clean:
	@echo "Cleaning up uncommitted files in $(DIST_DIR)..."
	git clean -f $(DIST_DIR)
