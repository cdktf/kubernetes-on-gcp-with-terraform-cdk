#!/bin/bash

set -ex

cd infrastructure
cdktf apply --auto-approve infrastructure
cdktf apply --auto-approve applications
