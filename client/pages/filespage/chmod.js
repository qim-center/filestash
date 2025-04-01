import React from "react";

export class ChmodComponent extends React.Component {

    checkboxLine(group, checks, index){
        return <p>{group}   {this.checkboxWithLabel(group, "Read", checks[0], index)} {this.checkboxWithLabel(group, "Write", checks[1], index+1)} {this.checkboxWithLabel(group, "Execute", checks[2], index+2)}</p>;
    }

    checkboxWithLabel(group, type, checked, index){
        let disabled = !(this.props.fileInfo.uid === this.props.userInfo.uid);
        return <span><input type="checkbox" id={group + type} onChange={this.props.onChange(index)} defaultChecked = {checked} disabled = {disabled}/><label for = {group + type}>{type}</label></span>;

    }


    render() {
        let perms = this.props.permissions;
        return (
        <div>
            <h4>Change of permissions</h4>
            { this.checkboxLine("User  ", perms.slice(0,3), 0) }
            { this.checkboxLine("Group ", perms.slice(3,6), 3) }
            { this.checkboxLine("All   ", perms.slice(6), 6) }
        </div>
        );
    };
}